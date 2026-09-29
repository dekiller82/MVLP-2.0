'use strict';

// Bluetooth is handled entirely in the main process (see main/ble-bridge.js).
// This module is a thin wrapper that mirrors which panels are connected so
// views can check synchronously.

const connected = new Set();

export function isSupported() {
  return true;
}

export function isConnected(id) {
  return connected.has(id);
}

export async function init() {
  const ids = await window.mvlp.invoke('ble:getConnected');
  ids.forEach((id) => connected.add(id));
  window.mvlp.on('device:connected', ({ id }) => connected.add(id));
  window.mvlp.on('device:disconnected', ({ id }) => connected.delete(id));
}

/** Connects by advertised name; rejects with the failure message. */
export async function connectDevice(name) {
  await window.mvlp.invoke('ble:connect', name);
  return name;
}

export async function disconnectDevice(id) {
  await window.mvlp.invoke('ble:disconnect', id);
  connected.delete(id);
}
