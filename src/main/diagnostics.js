'use strict';

const os = require('os');
const { app } = require('electron');

const store = require('./store');
const logger = require('./logger');

const LOG_LINES = 60;

const iso = (ms) => (ms ? new Date(ms).toISOString() : 'never');

/** The user's name appears in file paths; keep it out of something meant to be pasted into an issue. */
const redact = (text) => String(text).split(os.homedir()).join('~');

/**
 * A plain-text report for bug reports: versions, settings, what is connected, and the recent activity log.
 * It holds no Spotify credentials or tokens. It does contain panel names and settings, so it is worth a
 * glance before it is posted somewhere public.
 */
function buildDiagnostics({ controller, updater, bleBridge }) {
  const lines = [];
  const add = (text = '') => lines.push(text);

  add(`MVLP ${app.getVersion()} (${app.isPackaged ? 'installed build' : 'from source'})`);
  add(`Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, Node ${process.versions.node}`);
  add(`${process.platform} ${process.arch}, ${os.release()}`);
  add(`Time zone ${Intl.DateTimeFormat().resolvedOptions().timeZone}, report made ${new Date().toISOString()}`);

  add();
  add('Integrations');
  add(`  Multiviewer: ${controller.mvEnabled ? 'on' : 'off'}${controller.mvLive ? ', session live' : ''}, layout ${controller.mv.circuitStatus}`);
  add(`  Spotify: ${controller.spotifyEnabled ? 'on' : 'off'}${controller.spotifyActive ? ', playing' : ''}`);
  add(`  Idle screens: ${controller.idle ? 'showing' : 'not showing'}, night dimming ${controller.dimmed ? 'active' : 'inactive'}`);
  const held = controller.idleData?.data;
  if (held) add(`  Idle data fetched: calendar ${iso(held.calendar?.fetchedAt)}, results ${iso(held.results?.fetchedAt)}, standings ${iso(held.drivers?.fetchedAt)}`);

  add();
  add('Panels');
  const connected = new Set(bleBridge.getConnectedIds());
  const devices = Object.entries(store.getDevices() || {});
  if (!devices.length) add('  none saved');
  for (const [id, d] of devices) {
    add(`  ${d.name || id}: ${connected.has(id) ? 'connected' : 'not connected'}, ${d.width}x${d.height}, buffer ${d.buffer}, anchor 0x${Number(d.anchor).toString(16)}, brightness ${d.brightness}, auto-resize ${d.autoResize}, flipped ${d.flipDisplay}`);
  }

  add();
  add('Settings');
  add(`  ${JSON.stringify(store.getSettings())}`);

  add();
  add('Updates');
  const u = updater.state;
  add(`  ${u.status}${u.version ? `, latest ${u.version}` : ''}, in-app install ${u.canInstall ? 'supported' : 'not supported'}, last check ${iso(u.checkedAt)}`);

  add();
  add(`Recent activity (last ${LOG_LINES})`);
  for (const e of logger.getEntries().slice(-LOG_LINES)) {
    add(`  ${new Date(e.time).toISOString().slice(11, 19)} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${redact(e.message)}`);
  }
  return lines.join('\n');
}

module.exports = { buildDiagnostics };
