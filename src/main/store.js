'use strict';

const Store = require('electron-store');
const { safeStorage } = require('electron');

const store = new Store({
  name: 'mvlp-config',
  defaults: {
    devices: {},
    spotify: { clientId: '', clientSecretEnc: '' },
    settings: {
      launchAtLogin: false,
      minimizeToTray: true,
      startMinimized: false,
      mvEnabled: false,
      spotifyEnabled: false,
      notifications: true,
      fullSectorYellows: false,
      startupAnimation: true,
      yellowDisplay: 'number',
      onboardingComplete: false,
    },
  },
});

function getDevices() {
  return store.get('devices');
}

function getDevice(id) {
  return store.get(`devices.${id}`);
}

function setDevice(id, config) {
  store.set(`devices.${id}`, config);
}

function removeDevice(id) {
  store.delete(`devices.${id}`);
}

function getSettings() {
  return store.get('settings');
}

function setSetting(key, value) {
  store.set(`settings.${key}`, value);
}

function getSpotifyCredentials() {
  const clientId = store.get('spotify.clientId');
  const enc = store.get('spotify.clientSecretEnc');
  let clientSecret = '';
  if (enc) {
    try {
      clientSecret = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(enc, 'base64'))
        : Buffer.from(enc, 'base64').toString('utf8');
    } catch {
      clientSecret = '';
    }
  }
  return { clientId: clientId || '', clientSecret };
}

function setSpotifyCredentials(clientId, clientSecret) {
  store.set('spotify.clientId', clientId);
  const enc = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(clientSecret).toString('base64')
    : Buffer.from(clientSecret, 'utf8').toString('base64');
  store.set('spotify.clientSecretEnc', enc);
}

function getSpotifyTokens() {
  return store.get('spotifyTokens', null);
}

function setSpotifyTokens(tokens) {
  store.set('spotifyTokens', tokens);
}

module.exports = {
  store,
  getDevices,
  getDevice,
  setDevice,
  removeDevice,
  getSettings,
  setSetting,
  getSpotifyCredentials,
  setSpotifyCredentials,
  getSpotifyTokens,
  setSpotifyTokens,
};
