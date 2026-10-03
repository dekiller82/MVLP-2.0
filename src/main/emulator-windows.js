'use strict';

const path = require('path');
const { BrowserWindow } = require('electron');

const store = require('./store');
const { isEmulatedId } = require('./virtual-panel');

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 96;
const SAVE_BOUNDS_DELAY_MS = 400;

const PIXEL_STYLES = ['round', 'square', 'flat'];

/** What the emulator window needs to know about its panel. */
function windowConfig(id) {
  const c = store.getDevice(id) || {};
  return {
    id,
    name: c.name || id,
    width: c.width || 32,
    height: c.height || 32,
    pixelStyle: PIXEL_STYLES.includes(c.pixelStyle) ? c.pixelStyle : 'round',
    dotSize: c.dotSize,
    softness: c.softness,
    maskStrength: c.maskStrength,
    boost: c.boost,
  };
}

/**
 * Owns the emulator windows: one small, resizable, frameless window per emulated panel, each with its own taskbar entry. A window is open while its panel is on, unless the panel is set to open only while Multiviewer
 * is running. Closing a window hides the panel until it is opened again or Multiviewer reconnects.
 */
class EmulatorWindows {
  constructor({ bleBridge, controller, notify }) {
    this.ble = bleBridge;
    this.notify = notify; // (channel, ...args) => void, to the main window
    this.windows = new Map();
    this.dismissed = new Set(); // closed by the user
    this.forced = new Set(); // opened by hand while the "only with Multiviewer" rule would keep them shut
    this.mvRunning = false;

    this.ble.on('device-connected', (id) => { if (isEmulatedId(id)) { this.dismissed.delete(id); this.forced.delete(id); this.sync(id); } });
    this.ble.on('device-disconnected', (id) => { if (isEmulatedId(id)) this.sync(id); });
    this.ble.on('emulator-display', (id, state) => this._send(id, 'emulator:display', id, state));
    controller.on('mv:status', (state) => {
      this.mvRunning = state === 'connected';
      for (const id of this.ble.getEmulatedIds()) {
        this.dismissed.delete(id);
        this.forced.delete(id);
        this.sync(id);
      }
    });
  }

  isOpen(id) {
    return this.windows.has(id);
  }

  openIds() {
    return [...this.windows.keys()];
  }

  _shouldShow(id) {
    if (!this.ble.isConnected(id) || this.dismissed.has(id)) return false;
    const onlyWithMv = Boolean((store.getDevice(id) || {}).onlyWithMv);
    return !onlyWithMv || this.mvRunning || this.forced.has(id);
  }

  /** Opens or closes the panel's window to match the rules above. */
  sync(id) {
    const show = this._shouldShow(id);
    if (show && !this.windows.has(id)) this._create(id);
    else if (!show && this.windows.has(id)) this.windows.get(id).destroy();
  }

  /** The Devices page's button: opens the window now, or closes it until the next reason to open. */
  setOpen(id, open) {
    if (open) {
      if (!this.ble.isConnected(id)) return;
      this.dismissed.delete(id);
      this.forced.add(id);
    } else {
      this.dismissed.add(id);
      this.forced.delete(id);
    }
    this.sync(id);
  }

  /** The panel's size, name, pixel style or the Multiviewer rule changed. */
  configChanged(id) {
    const win = this.windows.get(id);
    if (win && !win.isDestroyed()) {
      const cfg = windowConfig(id);
      win.setTitle(cfg.name);
      win.setAspectRatio(cfg.width / cfg.height);
      this._send(id, 'emulator:config', cfg);
    }
    this.sync(id);
  }

  _send(id, channel, ...args) {
    const win = this.windows.get(id);
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    try { win.webContents.send(channel, ...args); } catch { /* window is closing */ }
  }

  _create(id) {
    const cfg = windowConfig(id);
    const saved = (store.getDevice(id) || {}).window || {};
    const width = Math.max(MIN_WIDTH, saved.width || DEFAULT_WIDTH);
    const height = saved.height || Math.round((width * cfg.height) / cfg.width);

    const win = new BrowserWindow({
      width,
      height,
      x: saved.x,
      y: saved.y,
      minWidth: MIN_WIDTH,
      resizable: true,
      frame: false, // no title bar: the whole screen is the window, dragged by its body and resized from its edges
      autoHideMenuBar: true,
      title: cfg.name,
      backgroundColor: '#000000',
      icon: path.join(__dirname, '..', '..', 'assets', 'icons', 'icon-256.png'),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.setAspectRatio(cfg.width / cfg.height);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'emulator.html'), { query: { id } });
    this.windows.set(id, win);

    let saveTimer = null;
    const saveBounds = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (win.isDestroyed()) return;
        const current = store.getDevice(id);
        if (current) store.setDevice(id, { ...current, window: win.getNormalBounds() });
      }, SAVE_BOUNDS_DELAY_MS);
    };
    win.on('resized', saveBounds);
    win.on('moved', saveBounds);

    // destroy() (used by sync) does not emit 'close', so this only sees the user closing the window.
    win.on('close', () => this.dismissed.add(id));
    win.on('closed', () => {
      clearTimeout(saveTimer);
      this.windows.delete(id);
      this.notify('emulator:windows', this.openIds());
    });
    this.notify('emulator:windows', this.openIds());
  }

  closeAll() {
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { EmulatorWindows, windowConfig, PIXEL_STYLES };
