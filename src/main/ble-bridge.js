'use strict';

const { EventEmitter } = require('events');
const noble = require('@stoprocent/noble');
const logger = require('./logger');
const store = require('./store');

const DEFAULT_DEVICE_CONFIG = {
  buffer: 1,
  autoResize: true,
  width: 32,
  height: 32,
  anchor: 0x33,
  duplicateHorizontally: false,
  brightness: 100,
  flipDisplay: false,
  clockStyle: 7,
};

// Confirmed against a real panel: the write characteristic (0xFA02) lives under
// the 16-bit service 0x00FA. noble reports UUIDs as lowercase, dash-less and
// shortened when they're Bluetooth-base UUIDs.
const SERVICE_UUID = '00fa';
const CHARACTERISTIC_UUID = 'fa02';

// Panels advertise only a local name (e.g. "LED_BLE_5DA07B31"), no service UUID.
const PANEL_NAME = /^(LED_BLE_|iPixel)/i;

// Matches the reference implementations (the original bleak-based app and
// pypixelcolor): every write is acknowledged (write-with-response), so the
// panel's own flow control paces us. Write-without-response floods it and the
// image is silently dropped. Payloads are split at 244 bytes (pypixelcolor's
// chunk size), safely under the minimum usable ATT payload.
const MAX_CHUNK_BYTES = 244;

const CONNECT_SCAN_TIMEOUT_MS = 10000;
const RECONNECT_INTERVAL_MS = 15000;
const CHOOSER_PUSH_INTERVAL_MS = 300;

const WRITE_TIMEOUT_MS = 8000;

const withTimeout = (promise, ms, message) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(message)), ms);
  promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeUuid = (uuid) => String(uuid).replace(/-/g, '').toLowerCase();
const matchesShortUuid = (uuid, short) => {
  const n = normalizeUuid(uuid);
  return n === short || n === `0000${short}00001000800000805f9b34fb`;
};

/**
 * Owns the live Bluetooth device registry. Talks to the panels directly from
 * the main process through noble (no browser permission model), so the app
 * controls the whole connection lifecycle: it scans, connects by advertised
 * name, and reconnects remembered panels on its own.
 *
 * Devices are keyed by advertised name - a stable, MAC-derived identifier that
 * is also what the persisted config uses as its id.
 */
class BleBridge extends EventEmitter {
  constructor(mainWindow) {
    super();
    this.mainWindow = mainWindow;
    /** @type {Map<string, {id:string,name:string,connected:boolean}>} */
    this.devices = new Map();
    /** @type {Map<string, any>} name -> noble peripheral seen while scanning */
    this.seen = new Map();
    /** @type {Map<string, {peripheral:any, characteristic:any, queue:Promise}>} */
    this.links = new Map();
    this.connecting = new Set();
    this.wanted = new Set(); // names we should keep trying to (re)connect
    this.scanUsers = 0;
    this.chooserOpen = false;
    this.chooserTimer = null;
    this.reconnectTimer = null;
    this.shuttingDown = false;

    noble.on('discover', (peripheral) => this._onDiscover(peripheral));
    noble.on('stateChange', (state) => {
      logger.info('Bluetooth', `Adapter state: ${state}`);
      if (state === 'poweredOn') this._kickReconnect();
    });

    // Every remembered panel is one we should reconnect to.
    Object.keys(store.getDevices()).forEach((name) => this.wanted.add(name));
    this.reconnectTimer = setInterval(() => this._kickReconnect(), RECONNECT_INTERVAL_MS);
    this._kickReconnect();
  }

  // ---- Adapter / scanning ------------------------------------------------

  async _waitForPoweredOn(timeoutMs = 5000) {
    if (noble.state === 'poweredOn') return;
    try {
      await noble.waitForPoweredOnAsync(timeoutMs);
    } catch {
      throw new Error('Bluetooth is off or unavailable. Turn Bluetooth on and try again.');
    }
  }

  async _startScan() {
    await this._waitForPoweredOn();
    this.scanUsers += 1;
    if (this.scanUsers === 1) {
      await noble.startScanningAsync([], true);
    }
  }

  async _stopScan() {
    this.scanUsers = Math.max(0, this.scanUsers - 1);
    if (this.scanUsers === 0) {
      try { await noble.stopScanningAsync(); } catch { /* adapter may already be idle */ }
    }
  }

  _onDiscover(peripheral) {
    const name = peripheral.advertisement?.localName;
    if (!name || !PANEL_NAME.test(name)) return;
    this.seen.set(name, peripheral);
    if (this.chooserOpen) this._scheduleChooserPush();
  }

  // ---- Chooser -----------------------------------------------------------

  async startChooser() {
    this.chooserOpen = true;
    this.seen.clear();
    try {
      await this._startScan();
    } catch (err) {
      this.chooserOpen = false;
      throw err;
    }
    this._scheduleChooserPush();
  }

  async stopChooser() {
    if (!this.chooserOpen) return;
    this.chooserOpen = false;
    clearTimeout(this.chooserTimer);
    this.chooserTimer = null;
    await this._stopScan();
  }

  _scheduleChooserPush() {
    if (this.chooserTimer) return;
    this.chooserTimer = setTimeout(() => {
      this.chooserTimer = null;
      if (!this.chooserOpen) return;
      const list = [...this.seen.keys()].map((name) => ({ deviceId: name, deviceName: name }));
      this._send('ble:chooserDevices', list);
    }, CHOOSER_PUSH_INTERVAL_MS);
  }

  _send(channel, payload) {
    const win = this.mainWindow;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    try { win.webContents.send(channel, payload); } catch { /* renderer mid-reload */ }
  }

  // ---- Connection --------------------------------------------------------

  /** Fills in any missing fields with defaults (merge, not replace) - self-healing
   * for configs saved before all fields existed, not just brand-new devices. */
  ensureDeviceConfig(id) {
    const existing = store.getDevice(id) || {};
    const merged = { ...DEFAULT_DEVICE_CONFIG, ...existing };
    store.setDevice(id, merged);
    return merged;
  }

  async _findPeripheral(name) {
    if (this.seen.has(name)) return this.seen.get(name);
    await this._startScan();
    try {
      const deadline = Date.now() + CONNECT_SCAN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (this.seen.has(name)) return this.seen.get(name);
        await sleep(200);
      }
    } finally {
      await this._stopScan();
    }
    throw new Error(`Could not find "${name}". Make sure the panel is powered on and in range.`);
  }

  /**
   * Connects to a panel by its advertised name. Resolves once the write
   * characteristic is ready; rejects (after reporting the failure) otherwise.
   */
  async connect(name) {
    if (this.links.has(name)) return name;
    if (this.connecting.has(name)) throw new Error('Already connecting to this device.');
    this.connecting.add(name);
    this.wanted.add(name);
    try {
      const peripheral = await this._findPeripheral(name);
      logger.info('Bluetooth', `Connecting to ${name}...`);
      await peripheral.connectAsync();

      const { characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
      const characteristic = characteristics.find((c) => matchesShortUuid(c.uuid, CHARACTERISTIC_UUID));
      if (!characteristic) {
        await peripheral.disconnectAsync().catch(() => {});
        throw new Error('Write characteristic (0xFA02) not found on this device.');
      }

      this.links.set(name, { peripheral, characteristic, queue: Promise.resolve() });
      peripheral.once('disconnect', () => this._onLinkLost(name));

      this.devices.set(name, { id: name, name, connected: true });
      this.ensureDeviceConfig(name);
      logger.info('Bluetooth', `Connected to ${name}.`);
      this.emit('device-connected', name, name);
      return name;
    } catch (err) {
      logger.warn('Bluetooth', `Failed to connect to ${name}: ${err.message}`);
      this.emit('device-connect-failed', name, err.message);
      throw err;
    } finally {
      this.connecting.delete(name);
    }
  }

  _onLinkLost(name) {
    if (!this.links.delete(name)) return;
    const dev = this.devices.get(name);
    if (dev) dev.connected = false;
    logger.info('Bluetooth', `Disconnected from ${name}.`);
    this.emit('device-disconnected', name);
  }

  /** User-initiated disconnect; stops auto-reconnect for this panel. */
  async disconnect(name) {
    this.wanted.delete(name);
    const link = this.links.get(name);
    if (!link) return;
    try { await link.peripheral.disconnectAsync(); } catch { /* already gone */ }
    this._onLinkLost(name);
  }

  /** Stops auto-reconnecting to a panel and drops the link (device removed). */
  async forget(name) {
    await this.disconnect(name);
    this.seen.delete(name);
  }

  _kickReconnect() {
    if (this.shuttingDown || noble.state !== 'poweredOn') return;
    for (const name of this.wanted) {
      if (this.links.has(name) || this.connecting.has(name)) continue;
      this.connect(name).catch(() => {});
    }
  }

  getConnectedIds() {
    return [...this.devices.values()].filter((d) => d.connected).map((d) => d.id);
  }

  isConnected(id) {
    return Boolean(this.devices.get(id)?.connected);
  }

  // ---- Writing -----------------------------------------------------------

  /** Sends payload buffers to a single device. Writes per device are serialized. */
  writeToDevice(deviceId, payloads) {
    const link = this.links.get(deviceId);
    if (!link) return Promise.reject(new Error('Device is not connected.'));
    const total = payloads.reduce((n, p) => n + p.length, 0);
    const run = async () => {
      logger.info('Bluetooth', `Writing ${total} bytes (${payloads.length} payload(s)) to ${deviceId}...`);
      for (const payload of payloads) {
        for (let offset = 0; offset < payload.length; offset += MAX_CHUNK_BYTES) {
          const chunk = payload.subarray(offset, offset + MAX_CHUNK_BYTES);
          await withTimeout(link.characteristic.writeAsync(chunk, false), WRITE_TIMEOUT_MS, 'BLE write timed out.');
        }
      }
      logger.info('Bluetooth', `Wrote ${total} bytes to ${deviceId}.`);
    };
    const result = link.queue.then(run, run);
    result.catch((err) => logger.warn('Bluetooth', `Write to ${deviceId} failed: ${err.message}`));
    link.queue = result.catch(() => {});
    return result;
  }

  async writeToAll(payloadsByDeviceId) {
    const ids = Object.keys(payloadsByDeviceId).filter((id) => this.isConnected(id));
    await Promise.allSettled(ids.map((id) => this.writeToDevice(id, payloadsByDeviceId[id])));
  }

  async shutdown() {
    this.shuttingDown = true;
    clearInterval(this.reconnectTimer);
    await Promise.allSettled([...this.links.values()].map((l) => l.peripheral.disconnectAsync()));
    try { await noble.stopScanningAsync(); } catch { /* ignore */ }
  }
}

module.exports = { BleBridge, DEFAULT_DEVICE_CONFIG };
