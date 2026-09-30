'use strict';

const { EventEmitter } = require('events');
const logger = require('./logger');

/**
 * Update checks against the GitHub releases of this project, plus in-app install where that can work.
 *
 * Finding out that a newer version exists is a plain request to the GitHub API and works everywhere.
 * Installing it from inside the app uses electron-updater and is offered only on Windows (the NSIS
 * installer) and on Linux for the AppImage. macOS cannot replace an app that is not code-signed, and a
 * .deb is managed by the package manager, so there the button opens the release page instead.
 */

const REPO = 'dekiller82/MVLP-2.0';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 6 * 3600000;
const FIRST_CHECK_DELAY_MS = 8000;

/** True if `a` is a newer version than `b` ("v2.1.0" and "2.1.0" both work; a pre-release is older than its release). */
function isNewer(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).replace(/^v/i, '').split('-');
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: Boolean(pre) };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d > 0;
  }
  return !x.pre && y.pre;
}

class Updater extends EventEmitter {
  /**
   * @param opts.currentVersion the running version
   * @param opts.canInstall     whether this build can replace itself (see above)
   * @param opts.getAutoUpdater returns electron-updater's autoUpdater (loaded only when needed)
   * @param opts.fetch          fetch implementation (for tests)
   */
  constructor({ currentVersion, canInstall = false, getAutoUpdater = null, fetch: fetchFn = (...a) => fetch(...a) } = {}) {
    super();
    this.currentVersion = currentVersion;
    this.canInstall = canInstall;
    this._getAutoUpdater = getAutoUpdater;
    this._fetch = fetchFn;
    this.timer = null;
    this.firstCheck = null;
    this.wired = false;
    this.state = { status: 'idle', currentVersion, canInstall, version: null, url: null, progress: 0, message: null, checkedAt: null };
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  /** Checks shortly after launch and then every few hours, if the user allows it. */
  startAutoCheck(enabled) {
    clearInterval(this.timer);
    clearTimeout(this.firstCheck);
    this.timer = null;
    this.firstCheck = null;
    if (!enabled) return;
    this.timer = setInterval(() => this.check().catch(() => {}), CHECK_INTERVAL_MS);
    this.timer.unref?.();
    this.firstCheck = setTimeout(() => this.check().catch(() => {}), FIRST_CHECK_DELAY_MS);
    this.firstCheck.unref?.();
  }

  /** Asks GitHub for the latest release. A manual check reports "up to date" and errors; automatic ones stay quiet. */
  async check({ manual = false } = {}) {
    if (['checking', 'downloading', 'downloaded'].includes(this.state.status)) return this.state;
    if (manual) this._set({ status: 'checking', message: null });
    try {
      const res = await this._fetch(LATEST_URL, { headers: { 'User-Agent': 'MVLP', Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const release = await res.json();
      const version = String(release.tag_name || '').replace(/^v/i, '');
      const checkedAt = Date.now();
      if (version && isNewer(version, this.currentVersion)) {
        this._set({ checkedAt, status: 'available', version, url: release.html_url, message: null });
      } else {
        this._set({ checkedAt, status: 'idle', version: null, url: null, message: manual ? 'You are on the latest version.' : null });
      }
    } catch (err) {
      logger.warn('Updater', `Update check failed: ${err.message}`);
      if (manual) this._set({ status: 'error', message: `Could not check for updates: ${err.message}` });
      else if (this.state.status === 'checking') this._set({ status: 'idle' });
    }
    return this.state;
  }

  _wire(autoUpdater) {
    if (this.wired) return;
    this.wired = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('download-progress', (p) => this._set({ status: 'downloading', progress: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', () => this._set({ status: 'downloaded', progress: 100 }));
    autoUpdater.on('update-not-available', () => this._set({ status: 'error', message: 'This release has no in-app update files. Use the download page instead.' }));
    autoUpdater.on('error', (err) => {
      logger.warn('Updater', `In-app update failed: ${err.message}`);
      this._set({ status: 'error', message: `Update failed: ${err.message}` });
    });
  }

  /** Downloads the update in the background (the state reports progress). Only where `canInstall`. */
  async download() {
    if (!this.canInstall || this.state.status === 'downloading') return;
    try {
      const autoUpdater = this._getAutoUpdater();
      this._wire(autoUpdater);
      this._set({ status: 'downloading', progress: 0, message: null });
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this._set({ status: 'error', message: `Update failed: ${err.message}` });
    }
  }

  install() {
    if (this.state.status !== 'downloaded') return;
    this._getAutoUpdater().quitAndInstall();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.firstCheck);
  }
}

module.exports = { Updater, isNewer, REPO };
