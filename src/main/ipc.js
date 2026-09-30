'use strict';

const fs = require('fs');
const { ipcMain, dialog, shell, app, Notification } = require('electron');

const store = require('./store');
const logger = require('./logger');
const autolaunch = require('./autolaunch');
const { REPO } = require('./updater');

function notify(title, body) {
  if (!store.getSettings().notifications) return;
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
}

function registerIpc({ mainWindow, bleBridge, controller, updater }) {
  const send = (channel, ...args) => {
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    try {
      mainWindow.webContents.send(channel, ...args);
    } catch {
      // Renderer can be between-frames (e.g. mid-crash-recovery reload);
      // dropping the message is fine, it's not on a critical path.
    }
  };

  controller.on('device:connected', ({ id, name }) => {
    send('device:connected', { id, name });
    notify('Device connected', name || id);
  });
  controller.on('device:disconnected', ({ id }) => {
    send('device:disconnected', { id });
    notify('Device disconnected', id);
  });
  controller.on('device:connect-failed', ({ id, message }) => {
    send('device:connect-failed', { id, message });
    notify('Connection failed', message || id);
  });
  controller.on('mv:status', (state) => send('mv:status', state));
  controller.on('mv:action', (action) => send('mv:action', action));
  controller.on('spotify:status', (status) => {
    send('spotify:status', status);
    if (status.state === 'error') notify('Spotify error', status.message || '');
  });
  logger.onEntry((entry) => send('log:entry', entry));

  // ---- Config -------------------------------------------------------------
  ipcMain.handle('config:getDevices', () => store.getDevices());
  ipcMain.handle('config:getDevice', (_e, id) => store.getDevice(id));
  ipcMain.handle('config:setDeviceOption', (_e, id, patch) => {
    const current = store.getDevice(id) || {};
    store.setDevice(id, { ...current, ...patch });
    return store.getDevice(id);
  });
  ipcMain.handle('config:removeDevice', (_e, id) => store.removeDevice(id));
  ipcMain.handle('config:getSettings', () => store.getSettings());
  ipcMain.handle('config:setSetting', (_e, key, value) => {
    store.setSetting(key, value);
    if (key === 'launchAtLogin') autolaunch.setLaunchAtLogin(value);
    if (key === 'fullSectorYellows' || key === 'yellowDisplay') controller.refreshYellowDisplay();
    if (/^(idle|night)/.test(key)) controller.refreshIdle();
    if (key === 'autoUpdateCheck') updater.startAutoCheck(Boolean(value) && app.isPackaged);
    return store.getSettings();
  });
  ipcMain.handle('config:getSpotifyCredentials', () => store.getSpotifyCredentials());

  // ---- Bluetooth chooser ----------------------------------------------------
  ipcMain.handle('ble:scanStart', () => bleBridge.startChooser());
  ipcMain.handle('ble:scanStop', () => bleBridge.stopChooser());

  // ---- Bluetooth connection (owned by bleBridge, which emits
  // 'device-connected' etc. for controller to react to) ----------------------
  ipcMain.handle('ble:connect', (_e, name) => bleBridge.connect(name));
  ipcMain.handle('ble:disconnect', (_e, name) => bleBridge.disconnect(name));
  ipcMain.handle('ble:getConnected', () => bleBridge.getConnectedIds());
  ipcMain.handle('ble:forgetDevice', async (_e, id) => {
    await bleBridge.forget(id);
    store.removeDevice(id);
  });

  // ---- Device actions -------------------------------------------------------
  ipcMain.handle('ble:eraseAll', (_e, id) => controller.eraseAll(id));
  ipcMain.handle('ble:setBrightness', (_e, id, value) => controller.setBrightness(id, value));
  ipcMain.handle('ble:setFlip', (_e, id, value) => controller.setFlip(id, value));
  ipcMain.handle('ble:sendExpert', (_e, id, hex) => controller.sendExpert(id, hex));
  ipcMain.handle('ble:sendGifPreset', (_e, gifName, deviceId) => controller.sendGifPresetByName(gifName, deviceId));
  ipcMain.handle('test:effect', (_e, kind, arg, deviceId) => controller.testEffect(kind, arg, deviceId));
  ipcMain.handle('ble:listPresetGifs', () => controller.listBundledGifs());
  ipcMain.handle('ble:sendClockToAll', () => controller.sendClockToAllConnected());

  ipcMain.handle('ble:writeFiles', async (_e, id, opts) => {
    const buffers = opts.filePaths.map((p) => fs.readFileSync(p));
    return controller.writeFiles(id, { ...opts, buffers });
  });

  // ---- Multiviewer / Spotify toggles ---------------------------------------
  ipcMain.handle('mv:setEnabled', (_e, enabled) => controller.setMultiviewerEnabled(enabled));
  ipcMain.handle('mv:getState', () => ({ enabled: controller.mvEnabled, action: controller.currentMvAction }));
  ipcMain.handle('spotify:getState', () => ({ enabled: controller.spotifyEnabled }));
  ipcMain.handle('spotify:saveAndConnect', async (_e, clientId, clientSecret) => {
    store.setSpotifyCredentials(clientId, clientSecret);
    await controller.setSpotifyEnabled(true, clientId, clientSecret);
  });
  ipcMain.handle('spotify:disconnect', () => controller.setSpotifyEnabled(false));

  // ---- App-level ---------------------------------------------------------
  ipcMain.handle('app:chooseFiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Image or Animation Files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Image/Animation Files', extensions: ['gif', 'png', 'jpg', 'jpeg', 'bmp'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('app:getVersion', () => app.getVersion());

  // ---- Updates ---------------------------------------------------------------
  ipcMain.handle('updater:getState', () => updater.state);
  ipcMain.handle('updater:check', () => updater.check({ manual: true }));
  ipcMain.handle('updater:download', () => updater.download());
  ipcMain.handle('updater:install', () => updater.install());
  ipcMain.handle('updater:openRelease', () => shell.openExternal(updater.state.url || `https://github.com/${REPO}/releases/latest`));
  ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:getLaunchAtLogin', () => autolaunch.getLaunchAtLogin());
  ipcMain.handle('app:quit', () => app.quit());

  // ---- Logging -------------------------------------------------------------
  ipcMain.handle('log:getEntries', () => logger.getEntries());
  // Renderer-originated trace points. Routed through main so the line is
  // guaranteed to hit the terminal even if the renderer crashes immediately
  // after - useful for pinning down exactly which async step a native
  // Bluetooth crash happened during.
  ipcMain.handle('debug:trace', (_e, scope, message) => logger.info(scope, message));
}

module.exports = { registerIpc };
