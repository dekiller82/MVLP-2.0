'use strict';

const { EventEmitter } = require('events');
const logger = require('./logger');

const MV_URL = 'http://127.0.0.1:10101/api/graphql';
const QUERY = { query: 'query { f1LiveTimingState { TrackStatus, SessionStatus, SessionInfo, SessionData, WeatherData, RaceControlMessages } f1LiveTimingClock { trackTime paused } players { type state { paused live currentTime interpolatedCurrentTime } driverData { tla } } }' };
const CIRCUIT_API = 'https://api.multiviewer.app/api/v1/circuits';
// Grid walkthrough: shown from this long before the scheduled start of a race, until the lights go out.
const GRID_LEAD_MS = 45 * 60000;
const GRID_TAIL_MS = 60 * 60000; // give up if the race is this late (avoids looping forever)
const GRID_POLL_MS = 15000;
const RESULT_RETRY_MS = 2000;
const RESULT_MAX_TRIES = 10;
const ACTION_MAP = { 1: 'green', 2: 'yellow', 4: 'sc', 5: 'red', 6: 'vsc', 7: 'vsc-ending' };

/** Short stable string for a piece of text, used to tell one grid order from another. */
function hashString(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** "04:00:00" / "-05:00:00" -> milliseconds. */
function parseGmtOffset(value) {
  const m = /^(-?)(\d+):(\d+)/.exec(String(value || ''));
  if (!m) return 0;
  return (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000;
}

/** "1:43.567" or "43.567" -> milliseconds, or null if blank/invalid. */
function parseLapTime(value) {
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(String(value || '').trim());
  if (!m) return null;
  return Math.round((Number(m[1] || 0) * 60 + Number(m[2])) * 1000);
}

/** Feed timestamps are UTC, with or without a trailing Z. */
function parseUtc(utc) {
  const text = String(utc || '');
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
}

/** When the session most recently went to 'Started' (-Infinity if it hasn't). */
function latestStartMs(sessionData) {
  let last = -Infinity;
  for (const e of sessionData?.StatusSeries || []) {
    if (e.SessionStatus === 'Started') last = Math.max(last, parseUtc(e.Utc));
  }
  return last;
}

/**
 * Applies one Race Control message to the flagged sectors: `list` is the yellow
 * sectors (most recent last) and `doubles` the ones whose latest flag is a double yellow.
 */
function applySectorFlag(state, msg) {
  if (msg.Category !== 'Flag') return state;
  if (msg.Scope === 'Track' && (msg.Flag === 'CLEAR' || msg.Flag === 'GREEN')) return { list: [], doubles: new Set() };
  if (msg.Scope !== 'Sector' || msg.Sector === undefined) return state;
  const sector = Number(msg.Sector);
  const list = state.list.filter((n) => n !== sector);
  const doubles = new Set(state.doubles);
  doubles.delete(sector);
  if (msg.Flag === 'YELLOW' || msg.Flag === 'DOUBLE YELLOW') {
    if (msg.Flag === 'DOUBLE YELLOW') doubles.add(sector);
    return { list: [...list, sector], doubles };
  }
  if (msg.Flag === 'CLEAR') return { list, doubles };
  return state;
}

class MultiviewerPoller extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.lastStatus = null;
    this.processedMessages = new Set();
    this.errorLogged = false;
    this.timer = null;
    this.sectorMap = null; // marshal (mini) sector number -> timing sector 1-3
    this.circuit = null; // { x, y, rotation, marshal:[{number,length}], name } for the current circuit
    this.circuitKey = null;
    this.circuitStatus = 'none'; // 'none' | 'ready' | 'unavailable' (not in the dataset) | 'error' (will retry)
    this.circuitRetryAt = 0;
    this.circuitLoading = false;
    this.drivers = null; // racing number -> { number, tla, name, team, color }
    this.driversLoading = null;
    this.sessionId = null; // which session the state belongs to, to notice a different one being loaded
    this.sectorMapKey = null;
    this._resetSessionState();
  }

  /** Per-session tracking. `seeded` gates event emission so a session that is
   * already under way when we connect doesn't replay its history as events. */
  _resetSessionState() {
    this.seeded = false;
    this.yellowSectors = [];
    this.doubleSectors = new Set();
    this.raining = false;
    this.chequered = false;
    this.fastestSeeded = false;
    this.overallBestMs = null;
    this.lastTimingPoll = 0;
    this.preSessionActive = false;
    this.preSessionTarget = undefined; // undefined = not tracked yet, null = delayed with no time
    this.preSessionTotalMs = 0;
    this.gridActive = false;
    this.gridWanted = false;
    this.gridSig = '';
    this.gridLoading = false;
    this.lastGridPoll = 0;
    this.resultKind = null; // 'podium' | 'pole' | null: what result screen is currently due
    this.sessionType = '';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastStatus = null;
    this.processedMessages.clear();
    this._resetSessionState();
    this.errorLogged = false;
    logger.info('Multiviewer', 'Polling started.');
    this._tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this._endPreSession();
    this._clearRaceScreens();
    this.emit('status', 'disabled');
    logger.info('Multiviewer', 'Polling stopped.');
  }

  /**
   * Everything here is rebuilt from the current message list on each tick, not
   * accumulated, so scrubbing backwards (or jumping around) in a replay can't
   * leave behind state from a moment that no longer exists.
   */
  _processMessages(messages) {
    const currentKeys = new Set();
    let flags = { list: [], doubles: new Set() };
    for (const msg of messages) {
      const key = `${msg.Utc}|${msg.Message}`;
      const isNew = !this.processedMessages.has(key) && !currentKeys.has(key);
      currentKeys.add(key);
      flags = applySectorFlag(flags, msg);

      if (!isNew || !this.seeded) continue; // history at connect time is state, not events

      const text = msg.Message || '';
      if (text.includes('SAFETY CAR IN THIS LAP')) this.emit('action', 'sc-ending');
      else if (text.includes('VIRTUAL SAFETY CAR ENDING')) this.emit('action', 'vsc-ending');
      if (msg.SubCategory === 'PitExit' && msg.Flag === 'CLOSED') this.emit('overlay', 'pitclosed');
      const winner = /FIRST CAR TO TAKE THE FLAG - CAR (\d+)/.exec(text);
      if (winner && this.sessionType === 'Race') this._announceWinner(winner[1]);
    }
    // Forget messages that are gone (scrubbed back past them) so they fire again when replayed.
    this.processedMessages = currentKeys;

    const yellow = flags.list;
    const same = yellow.length === this.yellowSectors.length
      && yellow.every((n, i) => n === this.yellowSectors[i] && flags.doubles.has(n) === this.doubleSectors.has(n));
    this.yellowSectors = yellow;
    this.doubleSectors = flags.doubles;
    if (!same || !this.seeded) this._emitYellowSectors();

  }

  /** Timing sector (1-3) a flagged marshal sector belongs to, or null if unknown. */
  fullSector(marshalSector) {
    return this.sectorMap?.[marshalSector] ?? null;
  }

  /**
   * Race Control flags use marshal-sector numbers (~20 per lap), not the three
   * timing sectors, and no feed maps one to the other. We approximate it by
   * position: place each marshal sector's midpoint on the lap (Multiviewer's
   * circuit data) and split the lap in the ratio of the timing sectors'
   * mini-sector segment counts (e.g. 8:10:9). Accurate to about one marshal
   * sector at the boundaries.
   */
  async _loadSectorMap() {
    if (this.circuitLoading) return;
    this.circuitLoading = true;
    try {
      await this._loadSectorMapInner();
    } catch (err) {
      this.circuitStatus = 'error';
      this.circuitRetryAt = Date.now() + 15000;
      logger.warn('Multiviewer', `Could not load the track layout: ${err.message}. Retrying shortly.`);
    } finally {
      this.circuitLoading = false;
    }
  }

  async _loadSectorMapInner() {
    const res = await fetch(MV_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query { f1LiveTimingState { SessionInfo, TimingData } }' }),
    });
    const state = (await res.json())?.data?.f1LiveTimingState;
    const circuitKey = state?.SessionInfo?.Meeting?.Circuit?.Key;
    const year = String(state?.SessionInfo?.StartDate || '').slice(0, 4);
    if (!circuitKey || !year) return;

    // The circuit outline is needed on its own (for the map), whether or not the
    // timing data for the sector map is available yet.
    const key = `${circuitKey}/${year}`;
    if (this.circuitKey !== key) {
      const res = await fetch(`${CIRCUIT_API}/${circuitKey}/${year}`, { headers: { 'User-Agent': 'MVLP' } });
      if (res.status === 404) {
        // Brand-new circuits aren't in Multiviewer's dataset; nothing to retry.
        this.circuitStatus = 'unavailable';
        logger.warn('Multiviewer', `No track layout is available for ${state?.SessionInfo?.Meeting?.Name || circuitKey} (circuit ${circuitKey}); using sector numbers instead.`);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const marshalList = [...(data.marshalSectors || [])].sort((a, b) => a.number - b.number).map((m) => ({ number: m.number, length: m.length }));
      if (marshalList.length && data.x?.length) {
        this.circuit = { x: data.x, y: data.y, rotation: data.rotation || 0, marshal: marshalList, name: data.circuitName || String(circuitKey) };
        this.circuitKey = key;
        this.circuitStatus = 'ready';
        logger.info('Multiviewer', `Circuit layout ready for ${this.circuit.name}.`);
        this.emit('circuit');
      }
    }
    if (this.sectorMapKey === key && this.sectorMap) return;

    // Take the largest segment count per sector across all drivers; a single
    // driver's list can be incomplete (e.g. before their first lap).
    let counts = null;
    for (const line of Object.values(state?.TimingData?.Lines || {})) {
      const c = (line.Sectors || []).map((s) => (s.Segments || []).length);
      if (c.length !== 3) continue;
      counts = counts ? counts.map((n, i) => Math.max(n, c[i])) : c;
    }
    if (counts && !counts.every((n) => n > 0)) counts = null;
    if (!counts) { logger.warn('Multiviewer', 'Full-sector yellows unavailable: no timing segment data.'); return; }
    if (!this.circuit) { logger.warn('Multiviewer', 'Full-sector yellows unavailable: no circuit data.'); return; }

    const circuit = this.circuit;
    const marshal = circuit.marshal;

    let lap = Math.hypot(circuit.x[0] - circuit.x.at(-1), circuit.y[0] - circuit.y.at(-1));
    for (let i = 1; i < circuit.x.length; i++) lap += Math.hypot(circuit.x[i] - circuit.x[i - 1], circuit.y[i] - circuit.y[i - 1]);

    const total = counts[0] + counts[1] + counts[2];
    const cut1 = (counts[0] / total) * lap;
    const cut2 = ((counts[0] + counts[1]) / total) * lap;

    const map = {};
    marshal.forEach((sec, i) => {
      const next = marshal[(i + 1) % marshal.length];
      const span = ((next.length - sec.length) % lap + lap) % lap;
      const mid = (sec.length + span / 2) % lap;
      map[sec.number] = mid < cut1 ? 1 : mid < cut2 ? 2 : 3;
    });
    this.sectorMap = map;
    this.sectorMapKey = `${circuitKey}/${year}`;
    logger.info('Multiviewer', `Sector map ready for ${circuit.name} (segments ${counts.join('/')}).`);
    this.emit('sector-map');
  }

  /**
   * Watches for a new overall fastest lap: the best lap time across all drivers
   * getting lower. TimingData is large, so this runs about once a second
   * rather than on every tick. The very first timed lap of a session is not
   * announced (it would just flash at the start of every race).
   */
  async _pollFastestLap() {
    if (Date.now() - this.lastTimingPoll < 1000) return;
    this.lastTimingPoll = Date.now();
    try {
      const res = await fetch(MV_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'query { f1LiveTimingState { TimingData } }' }),
      });
      const lines = (await res.json())?.data?.f1LiveTimingState?.TimingData?.Lines || {};
      let best = null;
      for (const line of Object.values(lines)) {
        const ms = parseLapTime(line?.BestLapTime?.Value);
        if (ms !== null && (best === null || ms < best)) best = ms;
      }
      if (best === null) return;
      const improved = this.fastestSeeded && this.overallBestMs !== null && best < this.overallBestMs;
      this.overallBestMs = best; // follows the feed both ways, so a scrub back doesn't leave a stale baseline
      this.fastestSeeded = true;
      if (improved) {
        logger.info('Multiviewer', `New fastest lap: ${best / 1000}s`);
        this.emit('overlay', 'fastest');
      }
    } catch { /* transient; try again next time */ }
  }

  /**
   * The feed's current time and whether it is running. `trackTime` on the clock
   * is only refreshed on events (play, pause, seek), it does not tick while
   * playing, so on its own it looks frozen. The player's position does tick, so
   * add how far the player has moved since that reading. Without a player,
   * fall back to the clock's own paused flag and a capped extrapolation from
   * when we last saw it change.
   */
  _feedClock(clock, players) {
    const track = Number(clock?.trackTime);
    if (!Number.isFinite(track)) return null;

    // Prefer the main broadcast window over driver onboards.
    const list = (players || []).filter((p) => p?.state);
    const player = list.find((p) => !p.driverData) || list[0];
    if (player) {
      const s = player.state;
      const moved = (Number(s.interpolatedCurrentTime) - Number(s.currentTime)) * 1000;
      return { trackTime: track + (Number.isFinite(moved) && !s.paused ? moved : 0), paused: Boolean(s.paused) };
    }

    const wall = Date.now();
    if (track !== this.lastTrackTime) { this.lastTrackTime = track; this.lastTrackSeenAt = wall; }
    const paused = Boolean(clock?.paused);
    return { trackTime: track + (paused ? 0 : Math.min(wall - (this.lastTrackSeenAt ?? wall), 30000)), paused };
  }

  /**
   * A different session was loaded (another track, or another session at the same
   * one) without the feed ever going empty in between. Everything learned about the
   * old one is void, including the circuit layout, which is only ever loaded when
   * a session starts being read.
   */
  _onSessionChanged(from, to) {
    logger.info('Multiviewer', `Session changed (${from} -> ${to}); starting fresh.`);
    this._endPreSession();
    this._clearRaceScreens();
    this._resetSessionState();
    this.lastStatus = null;
    this.processedMessages = new Set();
    this.circuit = null;
    this.circuitKey = null;
    this.circuitStatus = 'none';
    this.sectorMap = null;
    this.sectorMapKey = null;
    this.drivers = null;
    this.emit('session-changed');
  }

  // ---- Driver screens: grid walkthrough, winner, podium, pole ------------------------

  async _fetchState(fields) {
    const res = await fetch(MV_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `query { f1LiveTimingState { ${fields} } }` }),
    });
    return (await res.json())?.data?.f1LiveTimingState ?? null;
  }

  /** Drivers by racing number (code, name, team colour), loaded once per session. */
  async ensureDrivers() {
    if (this.drivers) return this.drivers;
    if (this.driversLoading) return this.driversLoading;
    this.driversLoading = (async () => {
      const state = await this._fetchState('DriverList');
      const map = new Map();
      for (const d of Object.values(state?.DriverList || {})) {
        const number = String(d.RacingNumber);
        map.set(number, { number, tla: d.Tla || number, name: d.FullName || '', team: d.TeamName || '', color: d.TeamColour || '' });
      }
      if (map.size) this.drivers = map;
      return this.drivers;
    })().finally(() => { this.driversLoading = null; });
    return this.driversLoading;
  }

  /** The current running order (or the grid, before a race) as an array of drivers with a `position`. */
  async currentOrder() {
    const drivers = await this.ensureDrivers();
    if (!drivers) return [];
    const timing = await this._fetchState('TimingData');
    const lines = Object.values(timing?.TimingData?.Lines || {});
    const ordered = lines
      .map((l) => ({ number: String(l.RacingNumber), position: Number(l.Position), line: Number(l.Line) }))
      .filter((l) => drivers.has(l.number))
      .sort((a, b) => (Number.isFinite(a.position) && Number.isFinite(b.position) ? a.position - b.position : a.line - b.line));
    return ordered.map((l, i) => ({ ...drivers.get(l.number), position: i + 1 }));
  }

  /**
   * Before a race: walk the grid. Active from a while before the scheduled start
   * until the lights go out (the session status leaves 'Inactive'). The running
   * order is polled slowly, since TimingData is large.
   */
  _processGrid(state, clock) {
    const info = state.SessionInfo || {};
    const feedNow = Number(clock?.trackTime);
    let wanted = false;
    if (info.Type === 'Race' && state.SessionStatus?.Status === 'Inactive' && Number.isFinite(feedNow)) {
      const scheduled = Date.parse(`${info.StartDate}Z`) - parseGmtOffset(info.GmtOffset);
      wanted = feedNow >= scheduled - GRID_LEAD_MS && feedNow <= scheduled + GRID_TAIL_MS;
    }
    this.gridWanted = wanted;
    if (!wanted) {
      this._endGrid();
      return;
    }
    if (!this.gridActive) {
      // Take hold of the display straight away; the order arrives a moment later.
      this.gridActive = true;
      this.gridSig = '';
      this.emit('grid', { active: true, pending: true });
    }
    if (!this.gridLoading && Date.now() - this.lastGridPoll >= GRID_POLL_MS) {
      this.lastGridPoll = Date.now();
      this._pollGrid();
    }
  }

  async _pollGrid() {
    this.gridLoading = true;
    try {
      const order = await this.currentOrder();
      if (!this.gridWanted || order.length < 2) return;
      const sig = hashString(order.map((d) => d.number).join(','));
      if (this.gridActive && sig === this.gridSig) return;
      this.gridActive = true;
      this.gridSig = sig;
      logger.info('Multiviewer', `Grid walkthrough: ${order.length} drivers.`);
      this.emit('grid', { active: true, drivers: order, sig });
    } catch (err) {
      logger.warn('Multiviewer', `Could not read the grid: ${err.message}`);
    } finally {
      this.gridLoading = false;
    }
  }

  _endGrid() {
    if (!this.gridActive) return;
    this.gridActive = false;
    this.gridSig = '';
    this.emit('grid', { active: false });
  }

  /** The winner, the moment Race Control says who took the flag first (a live event, not history). */
  async _announceWinner(number) {
    try {
      const drivers = await this.ensureDrivers();
      const driver = drivers?.get(number);
      if (driver) this.emit('result', { kind: 'winner', drivers: [{ ...driver, position: 1 }] });
    } catch (err) {
      logger.warn('Multiviewer', `Could not announce the winner: ${err.message}`);
    }
  }

  /**
   * The podium (race) and pole position (last qualifying segment) are state: they are
   * due once the session is over. Pole only after the end of Q3, never after Q1 or Q2.
   */
  _processResults(state) {
    const info = state.SessionInfo || {};
    const status = state.SessionStatus?.Status;
    const over = status === 'Finished' || status === 'Finalised' || status === 'Ends';
    const part = (state.SessionData?.Series || []).reduce((p, x) => (x.QualifyingPart > 0 ? x.QualifyingPart : p), 0);

    let kind = null;
    if (over && info.Type === 'Race') kind = 'podium';
    else if (over && info.Type === 'Qualifying' && part === 3) kind = 'pole';

    if (kind === this.resultKind) return;
    this.resultKind = kind;
    if (kind === null) this.emit('result', { kind: null });
    else this._loadResult(kind, 0);
  }

  /** Reads the top three (with retries while the feed still withholds them) and announces the result. */
  async _loadResult(kind, attempt) {
    try {
      const state = await this._fetchState('TopThree');
      const top = state?.TopThree;
      const lines = top && !top.Withheld ? top.Lines || [] : [];
      if (this.resultKind !== kind) return; // no longer due (scrubbed back, or session changed)
      if (!lines.length) {
        if (attempt < RESULT_MAX_TRIES) setTimeout(() => this._loadResult(kind, attempt + 1), RESULT_RETRY_MS);
        return;
      }
      const drivers = lines.slice(0, kind === 'podium' ? 3 : 1).map((l, i) => ({
        number: String(l.RacingNumber), tla: l.Tla, name: l.FullName || '', team: l.Team || '', color: l.TeamColour || '', position: i + 1,
      }));
      logger.info('Multiviewer', `${kind === 'podium' ? 'Podium' : 'Pole position'}: ${drivers.map((d) => d.tla).join(', ')}.`);
      this.emit('result', { kind, drivers });
    } catch (err) {
      logger.warn('Multiviewer', `Could not read the result: ${err.message}`);
    }
  }

  _clearRaceScreens() {
    this.gridWanted = false;
    this._endGrid();
    if (this.resultKind !== null) {
      this.resultKind = null;
      this.emit('result', { kind: null });
    }
  }

  _endPreSession() {
    if (!this.preSessionActive) return;
    this.preSessionActive = false;
    this.emit('pre-session', { active: false });
  }

  /**
   * Practice and qualifying: before the session starts, work out how long is
   * left to the start. The start time is the latest "... WILL START AT hh:mm"
   * Race Control message (track-local time), else the scheduled start; a delay
   * message with no time means "delayed, unknown". "Now" is the feed's own
   * clock, so it also behaves in a paused or replayed session.
   */
  _processPreSession(state, clock, messages) {
    const info = state.SessionInfo || {};
    const type = String(info.Type || '');
    const name = String(info.Name || '');
    const status = state.SessionStatus?.Status;
    const isPractice = type === 'Practice';
    const isQualifying = type === 'Qualifying';
    // Not while running (or red-flagged). Between qualifying segments the status
    // is 'Finished', then 'Inactive', so all three of those can precede a start.
    const waiting = status === 'Inactive' || status === 'Finished' || status === 'Finalised' || status === 'Ends';
    if ((!isPractice && !isQualifying) || !waiting) {
      this._endPreSession();
      return;
    }

    const offsetMs = parseGmtOffset(info.GmtOffset);
    const lastStart = latestStartMs(state.SessionData);

    // The latest start-time message since the session last started wins.
    let target = null;
    let announced = false;
    let sawDelay = false;
    let part = null;
    for (const msg of messages) {
      if (msg.SubCategory !== 'SessionStartDelayed') continue;
      if (parseUtc(msg.Utc) <= lastStart) continue; // about an earlier start
      sawDelay = true;
      const m = /(S?Q\d)?.*?WILL START AT (\d{1,2}):(\d{2})/i.exec(msg.Message || '');
      if (m) {
        const day = String(info.StartDate).slice(0, 10);
        target = Date.parse(`${day}T${m[2].padStart(2, '0')}:${m[3]}:00Z`) - offsetMs;
        announced = true;
        if (m[1]) part = Number(m[1].slice(-1));
      } else {
        announced = false;
        target = null; // delayed, no new time yet
      }
    }
    if (!sawDelay) {
      // Nothing announced: only the scheduled start, and only before the session has begun.
      if (status !== 'Inactive') {
        this._endPreSession();
        return;
      }
      target = Date.parse(`${info.StartDate}Z`) - offsetMs;
    }

    const nowMs = Number(clock?.trackTime);
    if (!Number.isFinite(nowMs) || Number.isNaN(target)) return;

    // Only while the start is still ahead (an announced time gets a short grace
    // period). Otherwise this is a stale schedule, e.g. after the last segment.
    const gap = target === null ? null : target - nowMs;
    if (gap !== null && gap < (announced ? -120000 : 0)) {
      this._endPreSession();
      return;
    }

    if (!this.preSessionActive || target !== this.preSessionTarget) {
      this.preSessionTarget = target;
      this.preSessionTotalMs = target === null ? 0 : Math.max(target - nowMs, 1);
    }
    this.preSessionActive = true;

    const remaining = target === null ? null : target - nowMs;
    const sessionPart = part ?? (state.SessionData?.Series || []).reduce((p, x) => (x.QualifyingPart > 0 ? x.QualifyingPart : p), 1);
    const sprint = /sprint/i.test(name) ? 'S' : '';
    const label = isQualifying ? `${sprint}Q${sessionPart}` : `P${(/\d+/.exec(name) || [''])[0]}`;

    this.emit('pre-session', {
      active: true,
      label,
      remainingMs: remaining,
      targetMs: target,
      totalMs: this.preSessionTotalMs,
      paused: Boolean(clock?.paused), // feed clock stopped (e.g. a paused replay)
    });
  }

  _emitYellowSectors() {
    this.emit('yellow-sectors', [...this.yellowSectors], new Set(this.doubleSectors));
  }

  _processWeather(weather) {
    if (!weather) return;
    const raining = Number(weather.Rainfall) > 0;
    if (raining && !this.raining && this.seeded) this.emit('overlay', 'rain');
    this.raining = raining;
  }

  /**
   * The chequered flag is state, not history: qualifying and practice show it at
   * the end of every segment, and its message stays in the log for good. It
   * counts only while it is the latest thing to have happened: the session
   * status says the session is over, or a chequered flag fell after the most
   * recent start. It clears again when the session restarts (Q1 -> Q2) or when
   * a replay is scrubbed back before it.
   */
  _processChequered(messages, sessionData, status) {
    const lastStart = latestStartMs(sessionData);
    let lastFlag = -Infinity;
    for (const m of messages) {
      if (m.Category === 'Flag' && m.Flag === 'CHEQUERED') lastFlag = Math.max(lastFlag, parseUtc(m.Utc));
    }
    const over = status === 'Finished' || status === 'Finalised' || status === 'Ends';
    const active = over || lastFlag > lastStart;

    if (active) {
      this._setChequered();
    } else if (this.chequered) {
      this.chequered = false;
      this.lastStatus = null; // so the current track status is announced again
      logger.info('Multiviewer', 'Chequered flag cleared (session running again).');
      this.emit('chequered-cleared');
    }
  }

  _setChequered() {
    if (this.chequered) return;
    this.chequered = true;
    logger.info('Multiviewer', 'Chequered flag.');
    this.emit('action', 'chequered');
  }

  async _tick() {
    if (!this.running) return;
    let delay = 100;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(MV_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(QUERY),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const liveTimingState = data?.data?.f1LiveTimingState;
      if (!liveTimingState) {
        // Multiviewer is reachable but has no live session (yet, or any more).
        // Report that so anything gated on a live session can resume, and
        // forget the last status so a returning session re-emits its flag.
        if (!this.errorLogged) {
          this.emit('status', 'retrying');
          this.errorLogged = true;
        }
        this.lastStatus = null;
        this._endPreSession();
        this._clearRaceScreens();
        this._resetSessionState();
        delay = 500;
      } else {
        this.emit('status', 'connected');
        this.errorLogged = false;

        const trackStatus = liveTimingState.TrackStatus || {};
        const status = String(trackStatus.Status || '');

        const rcMessages = liveTimingState.RaceControlMessages?.Messages || [];
        const info = liveTimingState.SessionInfo || {};
        this.sessionType = String(info.Type || '');
        const sessionId = `${info.Meeting?.Key ?? ''}/${info.Key ?? ''}`;
        if (this.sessionId !== null && sessionId !== this.sessionId) this._onSessionChanged(this.sessionId, sessionId);
        this.sessionId = sessionId;

        // Load the layout when a session starts being read, and retry after a failed
        // attempt (e.g. no network); a circuit that isn't in the dataset is not retried.
        if (!this.seeded || (this.circuitStatus === 'error' && Date.now() >= this.circuitRetryAt)) this._loadSectorMap();
        this._processMessages(rcMessages);
        this._processWeather(liveTimingState.WeatherData);
        this._processPreSession(liveTimingState, this._feedClock(data?.data?.f1LiveTimingClock, data?.data?.players), rcMessages);
        this._processChequered(rcMessages, liveTimingState.SessionData, liveTimingState.SessionStatus?.Status);
        this._processGrid(liveTimingState, this._feedClock(data?.data?.f1LiveTimingClock, data?.data?.players));
        this._processResults(liveTimingState);
        this.seeded = true;
        await this._pollFastestLap();

        if (status && status !== this.lastStatus) {
          this.lastStatus = status;
          logger.info('Multiviewer', `Track status changed to: ${status}`);
          const action = ACTION_MAP[status];
          if (action) this.emit('action', action);
        }
      }
    } catch (err) {
      if (!this.errorLogged) {
        this.emit('status', 'retrying');
        this.errorLogged = true;
      }
      delay = 1000;
    }

    if (this.running) {
      this.timer = setTimeout(() => this._tick(), delay);
    }
  }
}

module.exports = { MultiviewerPoller };
