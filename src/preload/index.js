'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'config:getDevices', 'config:getDevice', 'config:setDeviceOption', 'config:removeDevice',
  'config:getSettings', 'config:setSetting', 'config:getSpotifyCredentials',
  'ble:scanStart', 'ble:scanStop', 'ble:connect', 'ble:disconnect', 'ble:getConnected', 'ble:forgetDevice',
  'ble:eraseAll', 'ble:setBrightness', 'ble:setFlip', 'ble:sendExpert', 'ble:sendGifPreset',
  'ble:listPresetGifs', 'test:effect', 'ble:sendClockToAll', 'ble:writeFiles',
  'mv:setEnabled', 'mv:getState', 'spotify:saveAndConnect', 'spotify:disconnect', 'spotify:getState',
  'app:chooseFiles', 'app:getVersion', 'app:copyDiagnostics', 'whatsnew:pending', 'whatsnew:latest', 'app:openExternal', 'app:getLaunchAtLogin', 'app:quit',
  'updater:getState', 'updater:check', 'updater:download', 'updater:install', 'updater:openRelease',
  'log:getEntries', 'debug:trace',
]);

const EVENT_CHANNELS = new Set([
  'ble:chooserDevices',
  'device:connected', 'device:disconnected', 'device:connect-failed',
  'mv:status', 'mv:action', 'spotify:status', 'log:entry', 'updater:state', 'integrations:changed',
]);

contextBridge.exposeInMainWorld('mvlp', {
  invoke(channel, ...args) {
    if (!INVOKE_CHANNELS.has(channel)) return Promise.reject(new Error(`Blocked channel: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, callback) {
    if (!EVENT_CHANNELS.has(channel)) throw new Error(`Blocked channel: ${channel}`);
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
