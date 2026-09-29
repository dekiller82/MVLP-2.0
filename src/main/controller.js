'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const logger = require('./logger');
const store = require('./store');
const commands = require('./protocol/commands');
const writeData = require('./protocol/writeData');
const { makeSectorYellowGif } = require('./protocol/sectorGif');
const { makeGreenBorderGif, makeFastestLapGif, makeStartupGif } = require('./protocol/effectGifs');
const { makeCountdownGif, makeCountdownAnimation, viewFor } = require('./protocol/countdownGif');
const { makeYellowMap } = require('./protocol/trackMapGif');
const { makeGridWalkGif, makeWinnerGif, makePodiumGif, makePoleGif } = require('./protocol/resultGifs');
const { makeNextRaceGif, makeLastPodiumGif, makeStandingsGif } = require('./protocol/idleScreens');
const { IdleData } = require('./idleData');
const { MultiviewerPoller } = require('./multiviewer');
const { SpotifyManager } = require('./spotify');

const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');
const GIFS_DIR = path.join(ASSETS_DIR, 'gifs');

// Track status actions and the gif shown for each. The "-ending" and chequered
// entries are generated or bundled effects; see _gifBufferFor().
const ACTION_GIF_MAP = {
  green: 'green',
  yellow: 'yellow',
  red: 'red',
  sc: 'sc',
  vsc: 'vsc',
  'sc-ending': 'sc-ending',
  'vsc-ending': 'vsc-ending',
  chequered: 'chequered',
};

// Temporary displays that revert to the current track status afterwards.
const OVERLAY_DURATION_MS = 10000;
const OVERLAY_DURATIONS_MS = { fastest: 2000 };

// How long the startup animation is left on before the normal display takes over.
const STARTUP_HOLD_MS = 2200;

// Pacing of the end of a race or of the last qualifying segment. In a replay (and often live)
// the result is known the moment the flag falls, so without this the podium would replace the
// chequered flag almost at once.
const DEFAULT_FINISH_TIMINGS = {
  chequeredMinMs: 5000, // the chequered flag stays up this long before the winner screen
  winnerHoldMs: 10000, // the winner screen stays up at least this long
  winnerWaitCapMs: 120000, // if the top three still have not finished after the hold, give up waiting on the winner screen
};

// The idle rotation: what the panels show when no session is live and nothing is playing.
const IDLE_SLOT_MS = 10000; // each idle screen stays up this long
const IDLE_REFRESH_MS = 10 * 60000; // how often stale data is looked at (it is only fetched when past its TTL)
const NIGHT_CHECK_MS = 60000;

// The panel runs a countdown animation for at most this long (the last minute
// plus a little); before that it holds a still frame that is replaced each minute.
const ANIMATION_SPAN_MS = 65000;

// Transfer-time estimates: measured on a real panel, about 4-5 bytes per ms.
const DEFAULT_BYTES_PER_MS = 4.5;
const STILL_BYTES_GUESS = 200;
const ANIMATION_BYTES_GUESS = 10000;

const STOPPABLE_GIFS = new Set(['green', 'yellow', 'red', 'blue', 'white']);
const FIRST_FRAME_FREEZE_DELAY_MS = 3000;

class AppController extends EventEmitter {
  constructor(bleBridge) {
    super();
    this.ble = bleBridge;
    this.mv = new MultiviewerPoller();
    this.spotify = new SpotifyManager();

    this.mvEnabled = false;
    this.spotifyEnabled = false;
    this.currentMvAction = null;
    this.yellowSectors = [];
    this.doubleSectors = new Set(); // flagged sectors whose latest flag is a double yellow
    this.loopCache = new Map(); // gifName:size -> the looping animation a generated intro is replaced by
    this.overlayTimer = null;
    this.effectCache = new Map();
    // Bumped on every decision about what the panels should show. A send that was
    // started for an older decision is dropped if it is still being prepared when a
    // newer one is made, so a slow send (a big animation) can't overwrite a newer display.
    this.displayEpoch = 0;
    this.testTimer = null; // restores the real display after a test effect
    this.gridWalk = null; // { drivers, sig } while the grid is being walked before a race
    this.result = null; // { kind: 'podium' | 'pole', drivers } once a session's result is known
    this.winner = null; // the race winner, while their celebration is showing
    this.winnerTimer = null; // the celebration is on screen
    this.winnerStartTimer = null; // the celebration is waiting for the chequered flag to have been up long enough
    this.winnerDone = false;
    this.resultTimer = null; // the podium or pole screen is waiting its turn
    this.winnerHeld = false; // the winner screen is staying up until the top three have finished
    this.winnerCapTimer = null;
    this.resultVisible = false; // the podium or pole screen has taken over from the chequered flag
    this.chequeredShownAt = null; // when the chequered flag went up
    this.timings = { ...DEFAULT_FINISH_TIMINGS };
    this.preSession = null; // { state, receivedAt, planKey } while a practice/quali start is pending
    this.countdownRate = new Map(); // per panel: measured transfer speed in bytes per ms
    this.countdownTimer = null; // next scheduled (re)send of the countdown
    this.resyncTimer = null; // pending resend after the feed clock jumped
    this.countdownSending = false;
    this.countdownDirty = false;
    this.countdownAnimating = false; // the panel is running the final animation for the current plan
    this.startupActionsDone = false;
    this.isSendingArt = false;
    this.mvLive = false;
    this.lastArt = null;
    this.gifStopTimers = new Map();
    this.spotifyActive = false; // Spotify is playing (or was very recently): its art owns the panels
    this.idleData = null; // created on first use
    this.idle = null; // { index, timer, refreshTimer } while the idle rotation runs
    this.dimmed = false; // the panels are at night brightness
    this.nightTimer = setInterval(() => this._applyBrightness(), NIGHT_CHECK_MS);
    this.nightTimer.unref?.();

    this._wireEvents();
  }

  _wireEvents() {
    this.ble.on('device-connected', (id, name) => this.onDeviceConnected(id, name));
    this.ble.on('device-disconnected', (id) => this.onDeviceDisconnected(id));
    this.ble.on('device-connect-failed', (id, message) => this.onDeviceConnectFailed(id, message));

    this.mv.on('status', (state) => {
      this.emit('mv:status', state);
      this._onMvLiveChanged(state === 'connected');
    });
    this.mv.on('action', (action) => this._onMultiviewerAction(action));
    this.mv.on('overlay', (name) => this._onOverlay(name));
    this.mv.on('pre-session', (state) => this._onPreSession(state));
    this.mv.on('grid', (grid) => this._onGrid(grid));
    this.mv.on('result', (result) => this._onResult(result));
    this.mv.on('chequered-cleared', () => {
      if (this.currentMvAction === 'chequered') this.currentMvAction = null;
      this._resetFinish();
    });
    this.mv.on('yellow-sectors', (sectors, doubles) => this._onYellowSectors(sectors, doubles));
    this.mv.on('sector-map', () => this.refreshYellowDisplay());
    this.mv.on('circuit', () => this.refreshYellowDisplay());
    this.mv.on('session-changed', () => this._onSessionChanged());

    this.spotify.on('status', (status) => this.emit('spotify:status', status));
    this.spotify.on('art', (buffer) => this._onSpotifyArt(buffer));
    this.spotify.on('playback', (active) => this._onSpotifyPlayback(active));
  }

  // ---- Device lifecycle -------------------------------------------------

  async onDeviceConnected(id, name) {
    this.emit('device:connected', { id, name });

    try {
      await this.ble.writeToDevice(id, commands.erase({ eraseAll: true }));
    } catch (err) {
      logger.warn('Controller', `Erase-on-connect failed for ${id}: ${err.message}`);
    }

    await this._playStartup(id);

    // A session that's already live has a current flag; the panel may have
    // connected after it was first reported, so show that instead of the logo.
    const base = this.mvLive ? this._baseGifName() : null;
    if (this.preSession) await this._sendCountdownToDevice(id);
    else if (!base && this._shouldIdle()) await this._sendGifPresetToDevice(id, 'mv');
    else await this._sendGifPresetToDevice(id, base || 'mv');

    // Spotify's first track is fetched at launch, usually before any panel has
    // connected; show the cached art now rather than waiting for a track change.
    if (this._showsArt()) {
      await this._sendArtToDevice(id, this.lastArt);
    }

    this._updateIdle();
    this._applyBrightness();

    if (!this.startupActionsDone) {
      this.startupActionsDone = true;
      if (!this.mvEnabled) this.setMultiviewerEnabled(true);
    }
  }

  onDeviceDisconnected(id) {
    this.emit('device:disconnected', { id });
    const timer = this.gifStopTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.gifStopTimers.delete(id);
    }
  }

  onDeviceConnectFailed(id, message) {
    this.emit('device:connect-failed', { id, message });
  }

  // ---- Multiviewer --------------------------------------------------------

  setMultiviewerEnabled(enabled) {
    this.mvEnabled = enabled;
    store.setSetting('mvEnabled', enabled);
    if (enabled) {
      this.mv.start();
    } else {
      this.mv.stop();
      this._checkIdleState();
    }
  }

  /** Gif to show for the current track status (yellow shows the sector number when known). */
  _baseGifName() {
    if (this.gridWalk) return this.gridWalk.sig ? `gridwalk-${this.gridWalk.sig}` : null; // null while its order is still being read
    const action = this.currentMvAction;
    // Once the chequered flag has fallen, the result (podium or pole) replaces it when known.
    if (action === 'chequered' && this.result && this.resultVisible) return `result-${this.result.kind}`;
    // A trailing "d" means a double yellow, which flashes twice as fast.
    if (action === 'yellow' && this.yellowSectors.length && this._yellowMapReady()) {
      const double = this.yellowSectors.some((n) => this.doubleSectors.has(n));
      return `yellowmap-${this._mapSectors().join('.')}${double ? 'd' : ''}`;
    }
    if (action === 'yellow' && this.yellowSectors.length) {
      const latest = this.yellowSectors[this.yellowSectors.length - 1];
      const full = store.getSettings().fullSectorYellows ? this.mv.fullSector(latest) : null;
      return `yellow-${full ?? latest}${this.doubleSectors.has(latest) ? 'd' : ''}`;
    }
    return ACTION_GIF_MAP[action] || null;
  }

  /** Yellow flag as a track map, when chosen and the circuit layout is known. */
  _yellowMapReady() {
    return store.getSettings().yellowDisplay === 'map' && Boolean(this.mv.circuit);
  }

  /** Marshal sectors to light on the map (a whole timing sector each, in full-sector mode). */
  _mapSectors() {
    const flagged = this.yellowSectors;
    if (!store.getSettings().fullSectorYellows || !this.mv.sectorMap) return [...flagged].sort((a, b) => a - b);
    const fullFlagged = new Set(flagged.map((n) => this.mv.fullSector(n)).filter(Boolean));
    return Object.keys(this.mv.sectorMap).map(Number).filter((n) => fullFlagged.has(this.mv.sectorMap[n])).sort((a, b) => a - b);
  }

  /**
   * @param opts.settled show the flag in its settled form (the still, or the map's
   *   flashing loop) instead of replaying the attention-grabbing intro. Used when
   *   going back to a display that hasn't changed, e.g. after an overlay.
   */
  async _showBase({ settled = false } = {}) {
    const gifName = this._baseGifName();
    if (gifName) await this._sendGifPresetToAllConnected(gifName, { settled });
  }

  /** Short animation when a panel connects, so it's obvious the app has hold of it. */
  async _playStartup(id) {
    if (store.getSettings().startupAnimation === false) return;
    const epoch = this.displayEpoch;
    try {
      const buffer = await this._gifBufferFor('startup', store.getDevice(id) || {});
      await this._sendGifBuffer(id, 'startup', buffer, true, epoch);
      await new Promise((resolve) => setTimeout(resolve, STARTUP_HOLD_MS));
    } catch (err) {
      logger.warn('Controller', `Startup animation failed for ${id}: ${err.message}`);
    }
  }

  // ---- Test effects (Studio) ------------------------------------------------

  /**
   * Shows an effect on the panels on demand, so it can be checked without waiting
   * for the real event. It goes through the same display path as a real one, and
   * then the real display is put back. A real event that arrives meanwhile wins.
   *
   * @returns how many panels it was sent to
   */
  async testEffect(kind, arg, deviceId) {
    const ids = deviceId ? [deviceId] : this.ble.getConnectedIds();
    const targets = ids.filter((id) => this.ble.isConnected(id));
    if (!targets.length) return 0;

    const epoch = this._beginDisplay();
    clearTimeout(this.testTimer);
    this._clearOverlay();

    const named = { rain: 10000, pitclosed: 10000, chequered: 10000, 'sc-ending': 10000, 'vsc-ending': 10000, fastest: 2000 };
    let holdMs = 8000;
    let custom = null; // built per panel: (config) => Promise<Buffer>

    if (kind === 'yellow-map' || kind === 'yellow-map-double') {
      // Negative results tell the UI why: no session (-1), circuit not in the dataset (-2), layout not fetched yet (-3).
      if (this.mv.sessionId === null) return -1;
      if (!this.mv.circuit) return this.mv.circuitStatus === 'unavailable' ? -2 : -3;
      const sectors = String(arg ?? '5,6').split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const name = `yellowmap-${(sectors.length ? sectors : [5]).join('.')}${kind === 'yellow-map-double' ? 'd' : ''}`;
      await Promise.allSettled(targets.map((id) => this._sendGifPresetToDevice(id, name)));
    } else if (kind === 'yellow-sector' || kind === 'yellow-sector-double') {
      const n = Math.max(1, Math.min(99, Number(arg) || 1));
      await Promise.allSettled(targets.map((id) => this._sendGifPresetToDevice(id, `yellow-${n}${kind === 'yellow-sector-double' ? 'd' : ''}`)));
    } else if (named[kind]) {
      holdMs = named[kind];
      await Promise.allSettled(targets.map((id) => this._sendGifPresetToDevice(id, kind)));
    } else if (['grid-demo', 'winner-demo', 'podium-demo', 'pole-demo'].includes(kind)) {
      // Uses the drivers of whatever session is loaded in Multiviewer.
      const order = await this.mv.currentOrder().catch(() => []);
      if (order.length < 3) return -1;
      if (kind === 'grid-demo') {
        holdMs = Math.ceil(order.length / 2) * 2500 + 1000;
        custom = (c) => makeGridWalkGif(order, c.width ?? 32, c.height ?? 32);
      } else if (kind === 'winner-demo') {
        holdMs = this.timings.winnerHoldMs;
        custom = (c) => makeWinnerGif(order[0], c.width ?? 32, c.height ?? 32);
      } else if (kind === 'podium-demo') {
        custom = (c) => makePodiumGif(order.slice(0, 3), c.width ?? 32, c.height ?? 32);
      } else {
        custom = (c) => makePoleGif(order[0], c.width ?? 32, c.height ?? 32);
      }
    } else if (kind === 'idle-next' || kind === 'idle-podium' || kind === 'idle-standings') {
      const data = this._idleDataSource();
      await data.refresh().catch(() => {});
      const name = kind;
      const screen = this._idleScreens([name])[0];
      if (!screen) return -1;
      holdMs = 12000;
      custom = (c) => screen.build(c.width ?? 32, c.height ?? 32);
    } else if (kind === 'delayed') {
      custom = (c) => makeCountdownGif(viewFor('Q1', null, 0), c.width ?? 32, c.height ?? 32);
    } else if (kind === 'countdown') {
      const seconds = Math.max(5, Math.min(600, Number(arg) || 30));
      holdMs = seconds * 1000 + 3000;
      custom = (c) => makeCountdownAnimation({ label: 'Q1', startRemainingMs: seconds * 1000, totalMs: seconds * 1000 }, c.width ?? 32, c.height ?? 32).gif;
    } else if (kind === 'startup') {
      holdMs = STARTUP_HOLD_MS + 500;
      custom = (c) => this._gifBufferFor('startup', c);
    } else {
      return 0;
    }

    if (custom) {
      await Promise.allSettled(targets.map(async (id) => {
        const buffer = await custom(store.getDevice(id) || {});
        await this._sendGifBuffer(id, `test-${kind}`, buffer, true, epoch);
      }));
    }

    this.testTimer = setTimeout(() => {
      this.testTimer = null;
      if (epoch === this.displayEpoch) this._restoreDisplay();
    }, holdMs);
    return targets.length;
  }

  /** Puts back whatever the panels should really be showing. */
  _restoreDisplay() {
    this._beginDisplay();
    if (this.preSession) this._pushCountdown();
    else if (this._baseGifName()) this._showBase({ settled: true });
    else if (this._showsArt()) {
      this.ble.getConnectedIds().forEach((id) => this._sendArtToDevice(id, this.lastArt));
    } else if (this._shouldIdle()) {
      if (this.idle) this._idleAdvance(false);
      else this._startIdle();
    } else this._sendGifPresetToAllConnected('mv');
  }

  /** True while a screen owns the panels and flags or overlays should only be remembered, not shown. */
  _pinned() {
    return Boolean(this.preSession || this.gridWalk);
  }

  _beginDisplay() {
    this.displayEpoch += 1;
    return this.displayEpoch;
  }

  // ---- Pre-session countdown (practice / qualifying) ----------------------

  _onPreSession(state) {
    if (!state.active) {
      if (!this.preSession) return;
      this.preSession = null;
      this.countdownAnimating = false;
      this._clearCountdownTimers();
      // Put the track status back. This runs a moment later so that a status change
      // reported in the same poll (e.g. after scrubbing into a running session) is
      // handled first; if it makes its own display decision this one is dropped.
      const epoch = this._beginDisplay();
      setTimeout(() => {
        if (epoch !== this.displayEpoch || this._pinned()) return;
        if (this._baseGifName()) this._showBase();
        else this._sendGifPresetToAllConnected('mv');
      }, 0);
      return;
    }

    // The panel only runs short animations by itself (the last minute); before
    // that it holds a still frame that is replaced once a minute. So a resend is
    // needed when the countdown changes (new start time, delay, pause/resume),
    // when the feed clock jumps against real time (scrubbing or re-syncing a
    // replay), and at the scheduled points below. Every tick still refreshes the
    // latest reading, which is what a panel that connects later is built from.
    const now = Date.now();
    const previous = this.preSession;
    const planKey = `${state.label}|${state.targetMs}|${state.paused}`;
    this.preSession = { state, receivedAt: now, planKey };

    if (previous && previous.planKey === planKey) {
      if (!state.paused && state.remainingMs !== null && previous.state.remainingMs !== null) {
        const expected = previous.state.remainingMs - (now - previous.receivedAt);
        if (Math.abs(state.remainingMs - expected) > 1500) this._scheduleResync();
      }
      return;
    }

    this.countdownAnimating = false;
    this._beginDisplay();
    this._clearOverlay();
    const delayed = state.remainingMs === null;
    if (!previous || (previous.state.remainingMs === null) !== delayed) this.emit('mv:action', delayed ? 'delayed' : 'countdown');
    this._pushCountdown();
  }

  /** The feed clock jumped; wait for it to settle (a scrub drags through many values), then resend. */
  _scheduleResync() {
    clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      this.countdownAnimating = false;
      logger.info('Controller', 'Feed clock jumped - resending the countdown.');
      this._pushCountdown();
    }, 600);
  }

  _clearCountdownTimers() {
    clearTimeout(this.countdownTimer);
    clearTimeout(this.resyncTimer);
    this.countdownTimer = null;
    this.resyncTimer = null;
  }

  /** Time left right now, from the latest reading (null while delayed). */
  _countdownRemainingNow() {
    const ps = this.preSession;
    if (!ps || ps.state.remainingMs === null) return null;
    return ps.state.paused ? ps.state.remainingMs : ps.state.remainingMs - (Date.now() - ps.receivedAt);
  }

  /** Schedules the next send: the next minute change, or when the still-running animation should be tidied up. */
  _armCountdownTimer() {
    clearTimeout(this.countdownTimer);
    this.countdownTimer = null;
    const ps = this.preSession;
    const remaining = this._countdownRemainingNow();
    if (!ps || ps.state.paused || remaining === null) return;

    let waitMs;
    if (remaining > ANIMATION_SPAN_MS && !this.countdownAnimating) {
      const minutes = Math.ceil(Math.ceil(remaining / 1000) / 60);
      const boundary = Math.max((minutes - 1) * 60000, ANIMATION_SPAN_MS);
      // The send that lands on the 65 s mark is the animation; the others are stills.
      const payloadBytes = boundary === ANIMATION_SPAN_MS ? ANIMATION_BYTES_GUESS : STILL_BYTES_GUESS;
      waitMs = remaining - boundary - this._countdownTransferMs(payloadBytes);
    } else {
      waitMs = remaining + 5000; // the animation finished; if we're still waiting, show a still zero
    }
    this.countdownTimer = setTimeout(() => this._pushCountdown(), Math.max(500, waitMs));
  }

  /** Expected time to get `bytes` to the slowest connected panel (per-panel measured speed). */
  _countdownTransferMs(bytes, id) {
    const ids = id ? [id] : this.ble.getConnectedIds();
    const rates = ids.map((i) => this.countdownRate.get(i) ?? DEFAULT_BYTES_PER_MS);
    const slowest = rates.length ? Math.min(...rates) : DEFAULT_BYTES_PER_MS;
    return Math.round(bytes / slowest) + 100;
  }

  /** Sends the latest countdown to every panel, coalescing updates while one is in flight. */
  async _pushCountdown() {
    if (this.countdownSending) { this.countdownDirty = true; return; }
    this.countdownSending = true;
    try {
      do {
        this.countdownDirty = false;
        if (!this.preSession) break;
        this._beginDisplay();
        await Promise.allSettled(this.ble.getConnectedIds().map((id) => this._sendCountdownToDevice(id)));
      } while (this.countdownDirty);
    } finally {
      this.countdownSending = false;
      this._armCountdownTimer();
    }
  }

  /**
   * Builds the countdown from where it is right now (so a panel that connects
   * 25 seconds before the start just gets a 25 second animation) and sends it.
   */
  async _sendCountdownToDevice(id) {
    const ps = this.preSession;
    if (!ps) return;
    const { state } = ps;
    const epoch = this.displayEpoch;
    const config = store.getDevice(id) || {};
    const width = config.width ?? 32;
    const height = config.height ?? 32;
    // Whatever we send only starts showing once it has been transferred, so build
    // it for where the countdown will be by then. The transfer time depends on the
    // size, which depends on what is built, so build once, check the size, and
    // rebuild if the guess was off.
    const animationMs = this._countdownTransferMs(ANIMATION_BYTES_GUESS, id);
    const leftNow = () => state.remainingMs - (Date.now() - ps.receivedAt);
    // Once the animation could land within its window, that is what gets sent.
    const animate = state.remainingMs !== null && !state.paused && leftNow() - animationMs <= ANIMATION_SPAN_MS + 500;

    const build = (transferMs) => {
      if (state.remainingMs === null) return makeCountdownGif(viewFor(state.label, null, 0), width, height);
      if (state.paused) return makeCountdownGif(viewFor(state.label, state.remainingMs, 1 - state.remainingMs / state.totalMs), width, height);
      const landsAt = leftNow() - transferMs;
      if (landsAt <= 0) return makeCountdownGif(viewFor(state.label, 0, 1), width, height);
      if (animate) {
        return makeCountdownAnimation({ label: state.label, startRemainingMs: landsAt, totalMs: state.totalMs }, width, height).gif;
      }
      // A still frame, held until the next scheduled resend. The digit is picked
      // one second early so a slightly early timer can't show the old minute.
      return makeCountdownGif(viewFor(state.label, landsAt - 1000, 1 - landsAt / state.totalMs), width, height);
    };
    let transferMs = animate ? animationMs : this._countdownTransferMs(STILL_BYTES_GUESS, id);
    let buffer = build(transferMs);
    const sized = this._countdownTransferMs(buffer.length, id);
    if (Math.abs(sized - transferMs) > 250) {
      transferMs = sized;
      buffer = build(transferMs);
    }

    if (animate && buffer.length > 1000) this.countdownAnimating = true;
    const transferStartedAt = Date.now();
    await this._sendGifBuffer(id, 'countdown', buffer, true, epoch);
    const took = Date.now() - transferStartedAt;
    // Learn the panel's speed from payloads big enough for the figure to mean something.
    if (buffer.length > 2000 && took > 0) {
      const measured = buffer.length / took;
      const before = this.countdownRate.get(id);
      this.countdownRate.set(id, before === undefined ? measured : (before + measured) / 2);
    }
    logger.info('Controller', `Countdown sent to ${id} (${buffer.length} bytes, ${took} ms).`);
  }

  async _onMultiviewerAction(action) {
    // Once the chequered flag has fallen it stays up until the session ends.
    if (this.currentMvAction === 'chequered' && action !== 'chequered') return;
    // The same state can be signalled twice (e.g. a message and the status feed).
    if (action === this.currentMvAction && !this.overlayTimer) return;
    if (this._pinned()) { this.currentMvAction = action; return; } // shown once the session starts
    this._beginDisplay();
    this._clearOverlay();
    this.currentMvAction = action;
    if (action === 'chequered') {
      this.chequeredShownAt = Date.now();
      this.winnerDone = false;
      this.resultVisible = false;
    }
    this.emit('mv:action', action);
    await this._showBase();
  }

  // ---- Grid walkthrough, winner, podium and pole ----------------------------------

  _onGrid(grid) {
    if (!grid.active) {
      if (!this.gridWalk) return;
      this.gridWalk = null;
      // The lights are out: put the track status back, after any status change reported
      // in the same poll has had its say.
      const epoch = this._beginDisplay();
      setTimeout(() => {
        if (epoch !== this.displayEpoch || this._pinned()) return;
        if (this._baseGifName()) this._showBase();
        else this._sendGifPresetToAllConnected('mv');
      }, 0);
      return;
    }
    if (grid.pending) {
      // The grid walk is about to start: hold the display now so nothing flashes up meanwhile.
      if (!this.gridWalk) this.gridWalk = { drivers: null, sig: null };
      return;
    }
    const first = !this.gridWalk?.sig;
    const changed = first || this.gridWalk.sig !== grid.sig;
    this.gridWalk = { drivers: grid.drivers, sig: grid.sig };
    if (!changed) return;
    this._clearOverlay();
    this._beginDisplay();
    if (first) this.emit('mv:action', 'grid');
    this._sendGifPresetToAllConnected(`gridwalk-${grid.sig}`);
  }

  /** Milliseconds until the chequered flag has been up for its minimum time. */
  _flagDwellLeft() {
    if (!this.chequeredShownAt) return 0;
    return Math.max(0, this.chequeredShownAt + this.timings.chequeredMinMs - Date.now());
  }

  _clearFinishTimers() {
    clearTimeout(this.winnerTimer);
    clearTimeout(this.winnerStartTimer);
    clearTimeout(this.resultTimer);
    clearTimeout(this.winnerCapTimer);
    this.winnerTimer = null;
    this.winnerStartTimer = null;
    this.resultTimer = null;
    this.winnerCapTimer = null;
    this.winnerHeld = false;
  }

  _resetFinish() {
    this._clearFinishTimers();
    this.result = null;
    this.winner = null;
    this.winnerDone = false;
    this.resultVisible = false;
    this.chequeredShownAt = null;
  }

  /**
   * The end of a race or of the last qualifying segment plays out in order, however
   * early the data is known: the chequered flag first (for at least a while), then the
   * winner celebration, then the podium (or pole), which stays up.
   */
  _onResult({ kind, drivers, initial }) {
    if (kind === null) {
      const had = this.result || this.winner;
      this._resetFinish();
      if (had && this.currentMvAction === 'chequered') {
        this._beginDisplay();
        this._showBase();
      }
      return;
    }

    if (kind === 'winner') {
      clearTimeout(this.winnerStartTimer);
      this.winnerStartTimer = setTimeout(() => this._startWinner(drivers[0]), this._flagDwellLeft());
      return;
    }

    // Podium or pole: this stays up until the next session.
    this.result = { kind, drivers };
    this.resultVisible = false;
    clearTimeout(this.resultTimer);
    if (initial || this.winnerHeld) {
      // Connected after the finish, or the winner screen has been waiting for exactly this.
      this._revealResult();
      return;
    }
    // Otherwise after the chequered flag has had its time (a winner celebration that is
    // pending or on screen goes first; _revealResult holds the podium back until it is over).
    this.resultTimer = setTimeout(() => this._revealResult(), this._flagDwellLeft());
  }

  _startWinner(driver) {
    this.winnerStartTimer = null;
    this.winner = driver;
    const epoch = this._beginDisplay();
    this._clearOverlay();
    this.emit('mv:action', 'winner');
    clearTimeout(this.winnerTimer);
    this._sendGifPresetToAllConnected('result-winner');
    this.winnerTimer = setTimeout(() => {
      this.winnerTimer = null;
      this.winnerDone = true;
      if (this.result?.kind === 'podium') {
        this.resultVisible = true; // the top three are already home: the podium follows the celebration
        clearTimeout(this.resultTimer); // its own waiting timer is no longer needed
        this.resultTimer = null;
      } else if (!this.result && epoch === this.displayEpoch) {
        // The top three have not all finished yet: stay on the winner until they have.
        this.winnerHeld = true;
        this.winnerCapTimer = setTimeout(() => {
          this.winnerCapTimer = null;
          if (!this.winnerHeld) return;
          this.winnerHeld = false;
          if (epoch !== this.displayEpoch) return;
          this._beginDisplay();
          this._showBase(); // gave up waiting: back to the chequered flag
        }, this.timings.winnerWaitCapMs);
        return;
      }
      if (epoch !== this.displayEpoch) return;
      this._beginDisplay();
      this._showBase(); // the podium if it is due, otherwise the chequered flag
    }, this.timings.winnerHoldMs);
  }

  /** Puts the podium or pole screen up in place of the chequered flag. */
  _revealResult() {
    this.resultTimer = null;
    if (!this.result || this.resultVisible) return; // nothing to show, or already showing
    // A winner celebration is coming or on screen; the podium follows it.
    if (this.result.kind === 'podium' && (this.winnerStartTimer || this.winnerTimer)) return;
    this.winnerHeld = false;
    clearTimeout(this.winnerCapTimer);
    this.winnerCapTimer = null;
    this.resultVisible = true;
    this.emit('mv:action', this.result.kind);
    if (this.currentMvAction === 'chequered') {
      this._beginDisplay();
      this._showBase();
    }
  }

  /** A different session was loaded: nothing about the old one's display carries over. */
  _onSessionChanged() {
    this._clearOverlay();
    this._beginDisplay();
    this.currentMvAction = null;
    this.yellowSectors = [];
    this.doubleSectors = new Set();
    this.gridWalk = null;
    this._resetFinish();
    this.preSession = null;
    this.countdownAnimating = false;
    this._clearCountdownTimers();
  }

  _onYellowSectors(sectors, doubles = new Set()) {
    const before = this._baseGifName();
    this.yellowSectors = sectors;
    this.doubleSectors = doubles;
    if (this.currentMvAction !== 'yellow' || this.overlayTimer || this._pinned()) return;
    if (this._baseGifName() === before) return;
    this._beginDisplay();
    this._showBase();
  }

  /** Re-renders the yellow display after the mini/full sector setting (or map) changed. */
  refreshYellowDisplay() {
    if (this.currentMvAction !== 'yellow' || this.overlayTimer || this._pinned() || !this.yellowSectors.length) return;
    this._beginDisplay();
    this._showBase();
  }

  /** Shows a gif for a fixed time, then goes back to the track status display. */
  async _onOverlay(name) {
    if (this.currentMvAction === 'chequered' || this._pinned()) return;
    this._beginDisplay();
    this._clearOverlay();
    this.emit('mv:action', name);
    this.overlayTimer = setTimeout(() => {
      this.overlayTimer = null;
      if (this.currentMvAction) this.emit('mv:action', this.currentMvAction);
      this._beginDisplay();
      this._showBase({ settled: true }); // the flag hasn't changed: no flashing intro
    }, OVERLAY_DURATIONS_MS[name] ?? OVERLAY_DURATION_MS);
    await this._sendGifPresetToAllConnected(name);
  }

  _clearOverlay() {
    if (this.overlayTimer) clearTimeout(this.overlayTimer);
    this.overlayTimer = null;
  }

  async resendCurrentMvAction() {
    this._beginDisplay();
    await this._showBase();
  }

  // ---- Spotify ------------------------------------------------------------

  async setSpotifyEnabled(enabled, clientId, clientSecret) {
    this.spotifyEnabled = enabled;
    store.setSetting('spotifyEnabled', enabled);
    if (enabled) {
      await this.spotify.start(clientId, clientSecret);
    } else {
      this.spotify.stop();
      this._checkIdleState();
    }
  }

  /** A live Multiviewer session takes over the panels; Spotify waits until it ends. */
  _onMvLiveChanged(live) {
    if (live === this.mvLive) return;
    this.mvLive = live;
    logger.info('Controller', live ? 'Multiviewer session is live - pausing Spotify art.' : 'Multiviewer session ended - resuming Spotify art.');
    // Resuming makes Spotify re-emit the current track on its next poll.
    this.spotify.setSuspended(live);
    this._updateIdle();
    if (!live) {
      // Session over (or gone): forget its display state so a new one starts clean.
      this._clearOverlay();
      this.currentMvAction = null;
      this.yellowSectors = [];
      this.doubleSectors = new Set();
      this.gridWalk = null;
      this._resetFinish();
    }
  }

  async _sendArtToDevice(id, artBuffer) {
    const epoch = this.displayEpoch;
    const config = store.getDevice(id) || {};
    const timer = this.gifStopTimers.get(id);
    if (timer) {
      clearTimeout(timer); // a pending "freeze" of the previous gif must not overwrite the art
      this.gifStopTimers.delete(id);
    }
    const payloads = await writeData.writeAlbumArt({
      artBuffer,
      startBuffer: config.buffer ?? 1,
      deviceWidth: config.width ?? 32,
      deviceHeight: config.height ?? 32,
      anchor: config.anchor ?? 0x33,
      autoResize: config.autoResize ?? true,
    });
    if (epoch !== this.displayEpoch) return; // something newer was decided while this was being prepared
    await this.ble.writeToDevice(id, payloads).catch((err) => {
      logger.warn('Controller', `Album art write failed for ${id}: ${err.message}`);
    });
  }

  async _onSpotifyArt(artBuffer) {
    this.lastArt = artBuffer;
    this.spotifyActive = true;
    this._stopIdle();
    if (this.mvLive || this.isSendingArt) return;
    this._beginDisplay();
    this.isSendingArt = true;
    try {
      for (const id of this.ble.getConnectedIds()) await this._sendArtToDevice(id, artBuffer);
    } finally {
      this.isSendingArt = false;
    }
  }

  _checkIdleState() {
    if (!this.mvEnabled && !this.spotifyEnabled && !this._idleWanted()) {
      this.sendClockToAllConnected().catch(() => {});
    }
    this._updateIdle();
  }

  // ---- Idle screens and night dimming -------------------------------------

  _setting(key, fallback) {
    const value = store.getSettings()[key];
    return value === undefined ? fallback : value;
  }

  /** Spotify's art is what the panels show. */
  _showsArt() {
    return Boolean(this.spotifyEnabled && this.spotifyActive && !this.mvLive && this.lastArt);
  }

  _idleScreenNames() {
    const names = [];
    if (this._setting('idleNextRace', true)) names.push('idle-next');
    if (this._setting('idleLastPodium', true)) names.push('idle-podium');
    if (this._setting('idleStandings', true)) names.push('idle-standings');
    return names;
  }

  _idleWanted() {
    return Boolean(this._setting('idleEnabled', true) && this._idleScreenNames().length);
  }

  /** Nothing else has a claim on the panels. */
  _shouldIdle() {
    return this._idleWanted() && !this.mvLive && !this.preSession && !this._showsArt() && !this.testTimer && this.ble.getConnectedIds().length > 0;
  }

  _idleDataSource() {
    if (!this.idleData) {
      let cachePath = null;
      try { cachePath = path.join(require('electron').app.getPath('userData'), 'idle-cache.json'); } catch { /* no electron (tests) */ }
      let circuits = [];
      try { circuits = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'circuits.json'), 'utf8')); } catch { /* outlines are optional */ }
      this.idleData = new IdleData({ cachePath, circuits });
    }
    return this.idleData;
  }

  /** Starts or stops the rotation to match what is going on. */
  _updateIdle() {
    if (this._shouldIdle()) {
      if (!this.idle) this._startIdle();
    } else if (this.idle) {
      this._stopIdle();
    }
    this._applyBrightness();
  }

  /** Called when a setting that concerns the idle screens or night dimming changed. */
  refreshIdle() {
    if (this.idle) {
      this._stopIdle();
      this._updateIdle();
      if (!this.idle) this._restoreDisplay(); // the screens were switched off: put the normal display back
    } else {
      this._updateIdle();
      this._checkIdleState();
    }
  }

  _startIdle() {
    if (this.idle) return;
    this.idle = { index: -1, timer: null, refreshTimer: null };
    const refresh = () => this._idleDataSource().refresh().then((changed) => changed && this.idle && this._idleAdvance(false)).catch(() => {});
    this.idle.refreshTimer = setInterval(refresh, IDLE_REFRESH_MS);
    this.idle.refreshTimer.unref?.();
    logger.info('Controller', 'Nothing live and nothing playing: showing the idle screens.');
    this._idleAdvance(true);
    refresh();
  }

  _stopIdle() {
    if (!this.idle) return;
    clearTimeout(this.idle.timer);
    clearInterval(this.idle.refreshTimer);
    this.idle = null;
    this._applyBrightness();
  }

  /** What each idle screen can show right now; a screen without data is left out of the rotation. */
  _idleScreens(names = this._idleScreenNames()) {
    const data = this._idleDataSource();
    const screens = [];
    for (const name of names) {
      if (name === 'idle-next') {
        const race = data.nextRace();
        if (race) screens.push({ name, build: (w, h) => makeNextRaceGif({ race: data.nextRace() || race, outline: data.outlineFor(race) }, w, h) });
      } else if (name === 'idle-podium') {
        const podium = data.lastPodium();
        if (podium) screens.push({ name, build: (w, h) => makeLastPodiumGif(podium, w, h) });
      } else {
        const standings = data.standings();
        if (standings) screens.push({ name, build: (w, h) => makeStandingsGif(standings, w, h) });
      }
    }
    return screens;
  }

  /** Shows the next idle screen (or the current one again, if `next` is false) and schedules the one after. */
  _idleAdvance(next = true) {
    const idle = this.idle;
    if (!idle) return;
    clearTimeout(idle.timer);
    if (this.testTimer) {
      idle.timer = setTimeout(() => this._idleAdvance(true), 2000);
      return;
    }
    const screens = this._idleScreens();
    if (!screens.length) {
      // No data yet (first run offline): the panel's own clock until some arrives.
      this._beginDisplay();
      this.sendClockToAllConnected().catch(() => {});
      idle.timer = setTimeout(() => this._idleAdvance(true), IDLE_SLOT_MS * 3);
      return;
    }
    if (next) idle.index += 1;
    const screen = screens[Math.max(0, idle.index) % screens.length];
    const epoch = this._beginDisplay();
    Promise.allSettled(this.ble.getConnectedIds().map(async (id) => {
      const config = store.getDevice(id) || {};
      const buffer = screen.build(config.width ?? 32, config.height ?? 32);
      await this._sendGifBuffer(id, screen.name, buffer, true, epoch);
    })).catch(() => {});
    // A single screen has nothing to rotate to; do not resend it every slot.
    idle.timer = setTimeout(() => this._idleAdvance(true), screens.length > 1 ? IDLE_SLOT_MS : IDLE_REFRESH_MS);
  }

  /** Spotify started or stopped playing (it reports a stop only after a grace period). */
  _onSpotifyPlayback(active) {
    if (this.spotifyActive === active) return;
    this.spotifyActive = active;
    if (active) return; // the art event follows and takes over
    if (!this.mvLive && !this.preSession && !this.testTimer) {
      this._beginDisplay();
      if (this._shouldIdle()) this._startIdle();
      else this._sendGifPresetToAllConnected('mv');
    }
    this._applyBrightness();
  }

  /** Whether the local time is inside the night window. */
  _isNight(date = new Date()) {
    const parse = (text, fallback) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''));
      return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
    };
    const start = parse(this._setting('nightStart', '22:00'), 22 * 60);
    const end = parse(this._setting('nightEnd', '07:00'), 7 * 60);
    const now = date.getHours() * 60 + date.getMinutes();
    if (start === end) return false;
    return start < end ? now >= start && now < end : now >= start || now < end;
  }

  /** Night brightness applies only while the idle screens are up, so a live session is never dimmed. */
  _applyBrightness() {
    const wantDim = Boolean(this.idle && this._setting('nightDimming', true) && this._isNight());
    const nightLevel = Math.max(1, Math.min(100, Number(this._setting('nightBrightness', 20)) || 20));
    for (const id of this.ble.getConnectedIds()) {
      const configured = store.getDevice(id)?.brightness ?? 100;
      if (wantDim) {
        this.ble.writeToDevice(id, commands.brightness(Math.min(configured, nightLevel))).catch(() => {});
      } else if (this.dimmed) {
        this.ble.writeToDevice(id, commands.brightness(configured)).catch(() => {});
      }
    }
    this.dimmed = wantDim;
  }

  // ---- GIF presets ----------------------------------------------------------

  async _sendGifPresetToAllConnected(gifName, opts) {
    if (!this.ble.getConnectedIds().length) logger.warn('Controller', `Not sending "${gifName}": no panel is connected.`);
    await Promise.allSettled(this.ble.getConnectedIds().map((id) => this._sendGifPresetToDevice(id, gifName, opts)));
  }

  /** Bundled gifs by name, plus generated per-sector yellow flags ("yellow-<n>"). */
  async _gifBufferFor(gifName, config) {
    const width = config.width ?? 32;
    const height = config.height ?? 32;
    const sector = /^yellow-(\d+)(d?)$/.exec(gifName);
    if (sector) return makeSectorYellowGif(Number(sector[1]), width, height, { fast: sector[2] === 'd' });
    const map = /^yellowmap-([\d.]+?)(d?)$/.exec(gifName);
    if (map) {
      const { gif, loop } = makeYellowMap(this.mv.circuit, map[1].split('.').map(Number), width, height, { fast: map[2] === 'd' });
      this.loopCache.set(`${gifName}:${width}x${height}`, loop); // what takes over once the intro flashes are done
      return gif;
    }
    if (gifName.startsWith('gridwalk-')) return this.gridWalk ? makeGridWalkGif(this.gridWalk.drivers, width, height) : null;
    if (gifName === 'result-winner') return this.winner ? makeWinnerGif(this.winner, width, height) : null;
    if (gifName === 'result-podium') return this.result?.kind === 'podium' ? makePodiumGif(this.result.drivers, width, height) : null;
    if (gifName === 'result-pole') return this.result?.kind === 'pole' ? makePoleGif(this.result.drivers[0], width, height) : null;
    if (gifName === 'fastest') return makeFastestLapGif(width, height);
    if (gifName === 'startup') return makeStartupGif(path.join(GIFS_DIR, 'mv.gif'), width, height);
    if (gifName === 'sc-ending' || gifName === 'vsc-ending') {
      const key = `${gifName}:${width}x${height}`;
      if (!this.effectCache.has(key)) {
        const source = path.join(GIFS_DIR, `${gifName.split('-')[0]}.gif`);
        this.effectCache.set(key, await makeGreenBorderGif(source, width, height));
      }
      return this.effectCache.get(key);
    }
    const filePath = path.join(GIFS_DIR, `${gifName}.gif`);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  }

  async _sendGifPresetToDevice(id, gifName, { settled = false } = {}) {
    const epoch = this.displayEpoch;
    const config = store.getDevice(id) || {};
    const buffer = await this._gifBufferFor(gifName, config);
    if (!buffer) {
      logger.warn('Controller', `Missing bundled GIF: ${gifName}.gif`);
      return;
    }
    // Generated gifs are already exactly panel-sized; resizing them again
    // (even to the same size) shifts them and loses the last row and column.
    const generated = /^(yellow-\d+d?|yellowmap-[\d.]+d?|gridwalk-[a-z0-9]+|result-(winner|podium|pole)|fastest|sc-ending|vsc-ending|startup)$/.test(gifName);

    if (settled) {
      // Skip the flashing that announces a change: go straight to how it settles.
      const loop = this.loopCache.get(`${gifName}:${config.width ?? 32}x${config.height ?? 32}`);
      const stillable = STOPPABLE_GIFS.has(gifName) || gifName.startsWith('yellow-');
      if (loop || stillable) {
        const timer = this.gifStopTimers.get(id);
        if (timer) {
          clearTimeout(timer);
          this.gifStopTimers.delete(id);
        }
        logger.info('Controller', `Sending "${gifName}" (settled) to ${id}.`);
        if (loop) await this._switchToLoop(id, loop, epoch);
        else await this._freezeFirstFrame(id, buffer, generated, epoch);
        return;
      }
    }
    await this._sendGifBuffer(id, gifName, buffer, generated, epoch);
  }

  async _sendGifBuffer(id, gifName, buffer, generated, epoch = this.displayEpoch) {
    const config = store.getDevice(id) || {};
    if (gifName !== 'countdown') logger.info('Controller', `Sending "${gifName}" to ${id}.`);
    const timer = this.gifStopTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.gifStopTimers.delete(id);
    }

    const payloads = await writeData.writeGif({
      files: [buffer],
      startBuffer: config.buffer ?? 1,
      deviceWidth: config.width ?? 32,
      deviceHeight: config.height ?? 32,
      anchor: config.anchor ?? 0x33,
      autoResize: generated ? false : (config.autoResize ?? true),
    });
    if (epoch !== this.displayEpoch) {
      // Encoding takes a while; something newer was decided meanwhile and must not be overwritten.
      if (gifName !== 'countdown') logger.info('Controller', `Dropped stale "${gifName}" for ${id}.`);
      return;
    }
    await this.ble.writeToDevice(id, payloads).catch((err) => {
      logger.warn('Controller', `GIF write failed for ${id}: ${err.message}`);
    });

    if (STOPPABLE_GIFS.has(gifName) || gifName.startsWith('yellow-') || gifName.startsWith('yellowmap-')) {
      const t = setTimeout(() => {
        if (epoch !== this.displayEpoch) return;
        // The map animation opens with full-screen flashes; after those, the flagged
        // line keeps flashing on its own rather than settling on a still.
        const loop = this.loopCache.get(`${gifName}:${config.width ?? 32}x${config.height ?? 32}`);
        if (loop) this._switchToLoop(id, loop, epoch);
        else this._freezeFirstFrame(id, buffer, generated, epoch);
      }, FIRST_FRAME_FREEZE_DELAY_MS);
      this.gifStopTimers.set(id, t);
    }
  }

  /** Replaces the intro animation with a short loop that keeps running until the display changes. */
  async _switchToLoop(id, loopBuffer, epoch) {
    if (!this.ble.isConnected(id)) return;
    const config = store.getDevice(id) || {};
    try {
      const payloads = await writeData.writeGif({
        files: [loopBuffer],
        startBuffer: config.buffer ?? 1,
        deviceWidth: config.width ?? 32,
        deviceHeight: config.height ?? 32,
        anchor: config.anchor ?? 0x33,
        autoResize: false,
      });
      if (epoch !== this.displayEpoch) return; // something newer was decided while this was being prepared
      await this.ble.writeToDevice(id, payloads);
    } catch (err) {
      logger.warn('Controller', `Switching to the flashing map failed for ${id}: ${err.message}`);
    }
  }

  async _freezeFirstFrame(id, gifBuffer, generated = false, epoch = this.displayEpoch) {
    if (!this.ble.isConnected(id)) return;
    const config = store.getDevice(id) || {};
    try {
      const image = require('./protocol/image');
      const Jimp = require('jimp');
      const decoded = await Jimp.read(gifBuffer);
      // A generated gif is already exactly panel-sized: resizing it again, even to the
      // same size, shifts and blurs it, so the still must not differ from the animation.
      const still = await image.processStill(decoded, config.width ?? 32, config.height ?? 32, config.anchor ?? 0x33, generated ? false : (config.autoResize ?? true));
      const pngBuffer = await still.getBufferAsync(Jimp.MIME_PNG);
      const payloads = await writeData.writePng({
        files: [pngBuffer],
        startBuffer: config.buffer ?? 1,
        deviceWidth: config.width ?? 32,
        deviceHeight: config.height ?? 32,
        anchor: config.anchor ?? 0x33,
        autoResize: false,
      });
      if (epoch !== this.displayEpoch) return; // something newer was decided while this was being prepared
      await this.ble.writeToDevice(id, payloads);
    } catch (err) {
      logger.warn('Controller', `First-frame freeze failed for ${id}: ${err.message}`);
    }
  }

  async sendGifPresetByName(gifName, deviceId) {
    const count = deviceId ? (this.ble.isConnected(deviceId) ? 1 : 0) : this.ble.getConnectedIds().length;
    if (deviceId) await this._sendGifPresetToDevice(deviceId, gifName);
    else await this._sendGifPresetToAllConnected(gifName);
    return count;
  }

  listBundledGifs() {
    if (!fs.existsSync(GIFS_DIR)) return [];
    return fs
      .readdirSync(GIFS_DIR)
      .filter((f) => f.toLowerCase().endsWith('.gif'))
      .map((f) => f.replace(/\.gif$/i, ''));
  }

  // ---- Clock ----------------------------------------------------------------

  async sendClockToAllConnected() {
    await Promise.allSettled(this.ble.getConnectedIds().map((id) => this.sendClockToDevice(id)));
  }

  async sendClockToDevice(id) {
    const config = store.getDevice(id) || {};
    const payloads = commands.clockMode({ style: config.clockStyle ?? 7, date: new Date(), showDate: true, show24h: true });
    await this.ble.writeToDevice(id, payloads);
  }

  // ---- Manual device controls -------------------------------------------

  async setBrightness(id, value) {
    const config = store.getDevice(id) || {};
    config.brightness = value;
    store.setDevice(id, config);
    await this.ble.writeToDevice(id, commands.brightness(value));
    await this.resendCurrentMvAction();
  }

  async setFlip(id, isFlipped) {
    const config = store.getDevice(id) || {};
    config.flipDisplay = isFlipped;
    store.setDevice(id, config);
    await this.ble.writeToDevice(id, commands.upsideDown(isFlipped));
    await this.resendCurrentMvAction();
  }

  async eraseAll(id) {
    await this.ble.writeToDevice(id, commands.erase({ eraseAll: true }));
  }

  async sendExpert(id, hex) {
    await this.ble.writeToDevice(id, commands.expert(hex));
  }

  async writeFiles(id, { buffers, isGif, startBuffer, joinImageFiles, makeFromImage }) {
    const config = store.getDevice(id) || {};
    const opts = {
      files: buffers,
      startBuffer: startBuffer ?? config.buffer ?? 1,
      deviceWidth: config.width ?? 32,
      deviceHeight: config.height ?? 32,
      anchor: config.anchor ?? 0x33,
      autoResize: config.autoResize ?? true,
    };
    const payloads = isGif
      ? await writeData.writeGif({ ...opts, makeFromImage: makeFromImage || 0 })
      : await writeData.writePng({ ...opts, joinImageFiles: Boolean(joinImageFiles) });
    await this.ble.writeToDevice(id, payloads);
  }

  async shutdown() {
    clearInterval(this.nightTimer);
    this._stopIdle();
    this.mv.stop();
    this.spotify.stop();
    try {
      await this.sendClockToAllConnected();
    } catch { /* best effort */ }
  }
}

module.exports = { AppController, GIFS_DIR };
