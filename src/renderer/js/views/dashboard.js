'use strict';

import { showToast } from '../components/toast.js';
import { confirmModal } from '../components/modal.js';
import { openSpotifyCredentialsModal } from './spotify-credentials-modal.js';
import { escapeHtml } from '../util.js';

const FLAG_LABELS = {
  green: 'Track Clear', yellow: 'Caution', red: 'Session Stopped',
  sc: 'Safety Car', vsc: 'Virtual Safety Car', ending: 'Resuming',
  chequered: 'Chequered Flag', pitclosed: 'Pit Exit Closed', rain: 'Rain',
  'sc-ending': 'Safety Car In This Lap', 'vsc-ending': 'VSC Ending', fastest: 'Fastest Lap',
  countdown: 'Session Starting', delayed: 'Start Delayed',
  grid: 'Grid Walk', winner: 'Race Winner', podium: 'Podium', pole: 'Pole Position',
};

let mounted = false;
let unsubscribers = [];

export async function render(section) {
  section.innerHTML = `
    <div class="view-header">
      <div>
        <h1>Dashboard</h1>
        <p>Live status of your integrations and panels.</p>
      </div>
    </div>
    <div class="grid grid-2">
      <div class="card" id="mv-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Multiviewer for F1</h3>
            <p class="card-subtitle">Shows live track status on your panel.</p>
          </div>
          <label class="switch"><input type="checkbox" id="mv-toggle" /><span class="track"></span></label>
        </div>
        <div class="flag-indicator">
          <div class="flag-swatch" id="mv-swatch">—</div>
          <div>
            <div class="flag-name" id="mv-flag-name">No signal</div>
            <div class="flag-sub" id="mv-flag-sub">Enable the integration to see live status</div>
          </div>
        </div>
        <span class="badge" id="mv-badge"><span class="dot"></span>Disabled</span>
      </div>

      <div class="card" id="spotify-card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Spotify Album Art</h3>
            <p class="card-subtitle">Displays what's currently playing.</p>
          </div>
          <label class="switch"><input type="checkbox" id="spotify-toggle" /><span class="track"></span></label>
        </div>
        <span class="badge" id="spotify-badge"><span class="dot"></span>Disabled</span>
        <p class="help-text" id="spotify-message"></p>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card" id="devices-summary-card">
        <div class="card-header">
          <h3 class="card-title">Connected Panels</h3>
          <button class="btn btn-sm" id="goto-devices">Manage</button>
        </div>
        <div id="devices-summary"></div>
      </div>

      <div class="card">
        <h3 class="card-title">Quick Actions</h3>
        <button class="btn btn-block" id="qa-clock">Send Clock to All Panels</button>
        <button class="btn btn-block btn-danger" id="qa-erase">Erase All Buffers</button>
      </div>
    </div>
  `;

  if (!mounted) {
    mounted = true;
  }
  unsubscribers.forEach((fn) => fn());
  unsubscribers = [];

  const mvToggle = section.querySelector('#mv-toggle');
  const spotifyToggle = section.querySelector('#spotify-toggle');

  const [mvState, spotifyState, devices] = await Promise.all([
    window.mvlp.invoke('mv:getState'),
    window.mvlp.invoke('spotify:getState'),
    window.mvlp.invoke('config:getDevices'),
  ]);

  mvToggle.checked = mvState.enabled;
  setMvBadge(section, mvState.enabled ? 'connected' : 'disabled');
  if (mvState.action) setFlag(section, mvState.action);

  spotifyToggle.checked = spotifyState.enabled;
  setSpotifyBadge(section, spotifyState.enabled ? 'connected' : 'disabled');

  renderDevicesSummary(section, devices);

  mvToggle.addEventListener('change', async () => {
    await window.mvlp.invoke('mv:setEnabled', mvToggle.checked);
    if (!mvToggle.checked) setFlag(section, null);
  });

  spotifyToggle.addEventListener('change', async () => {
    if (spotifyToggle.checked) {
      const creds = await window.mvlp.invoke('config:getSpotifyCredentials');
      if (!creds.clientId || !creds.clientSecret) {
        spotifyToggle.checked = false;
        openSpotifyCredentialsModal({ clientId: creds.clientId, onSaved: () => render(section) });
        return;
      }
      await window.mvlp.invoke('spotify:saveAndConnect', creds.clientId, creds.clientSecret);
    } else {
      await window.mvlp.invoke('spotify:disconnect');
    }
  });

  section.querySelector('#goto-devices').addEventListener('click', () => {
    document.querySelector('.nav-item[data-view="devices"]').click();
  });

  section.querySelector('#qa-clock').addEventListener('click', async () => {
    await window.mvlp.invoke('ble:sendClockToAll');
    showToast('Clock sent to all connected panels.', 'success');
  });

  section.querySelector('#qa-erase').addEventListener('click', async () => {
    const ok = await confirmModal({
      title: 'Erase all buffers?',
      message: 'This clears every saved image/animation slot on all connected panels. This cannot be undone.',
      confirmLabel: 'Erase',
      danger: true,
    });
    if (!ok) return;
    const ids = Object.keys(devices);
    await Promise.all(ids.map((id) => window.mvlp.invoke('ble:eraseAll', id)));
    showToast('Erase command sent.', 'success');
  });

  unsubscribers.push(window.mvlp.on('mv:status', (state) => setMvBadge(section, state)));
  unsubscribers.push(window.mvlp.on('mv:action', (action) => setFlag(section, action)));
  unsubscribers.push(window.mvlp.on('spotify:status', (status) => setSpotifyBadge(section, status.state, status.message)));
  // The tray menu can switch an integration too; redraw so the toggles match.
  unsubscribers.push(window.mvlp.on('integrations:changed', () => {
    if (section.hidden) return;
    render(section);
  }));
  unsubscribers.push(window.mvlp.on('device:connected', () => refreshDevicesSummary(section)));
  unsubscribers.push(window.mvlp.on('device:disconnected', () => refreshDevicesSummary(section)));
}

async function refreshDevicesSummary(section) {
  if (section.hidden) return;
  const devices = await window.mvlp.invoke('config:getDevices');
  renderDevicesSummary(section, devices);
}

function renderDevicesSummary(section, devices) {
  const el = section.querySelector('#devices-summary');
  const entries = Object.entries(devices);
  if (!entries.length) {
    el.innerHTML = '<p class="help-text">No panels added yet.</p>';
    return;
  }
  el.innerHTML = entries
    .map(([id, cfg]) => `<div class="row-between" style="padding:6px 0;">
      <div class="row-label"><strong>${escapeHtml(cfg.name || 'iPixel Device')}</strong><span>${cfg.width}×${cfg.height}</span></div>
    </div>`)
    .join('');
}

function setMvBadge(section, state) {
  const badge = section.querySelector('#mv-badge');
  if (!badge) return;
  badge.className = 'badge';
  if (state === 'connected') { badge.classList.add('success'); badge.innerHTML = '<span class="dot"></span>Connected'; }
  else if (state === 'retrying') { badge.classList.add('warning'); badge.innerHTML = '<span class="dot"></span>Reconnecting…'; }
  else { badge.innerHTML = '<span class="dot"></span>Disabled'; }
}

function setSpotifyBadge(section, state, message) {
  const badge = section.querySelector('#spotify-badge');
  const msgEl = section.querySelector('#spotify-message');
  if (!badge) return;
  badge.className = 'badge';
  if (state === 'connected') { badge.classList.add('success'); badge.innerHTML = '<span class="dot"></span>Connected'; if (msgEl) msgEl.textContent = ''; }
  else if (state === 'error') { badge.classList.add('danger'); badge.innerHTML = '<span class="dot"></span>Error'; if (msgEl) msgEl.textContent = message || ''; }
  else { badge.innerHTML = '<span class="dot"></span>Disabled'; if (msgEl) msgEl.textContent = ''; }
}

function setFlag(section, action) {
  const swatch = section.querySelector('#mv-swatch');
  const nameEl = section.querySelector('#mv-flag-name');
  const subEl = section.querySelector('#mv-flag-sub');
  if (!swatch) return;
  swatch.className = 'flag-swatch';
  if (!action) {
    swatch.textContent = '—';
    nameEl.textContent = 'No signal';
    subEl.textContent = 'Enable the integration to see live status';
    return;
  }
  swatch.classList.add(action);
  swatch.textContent = action.toUpperCase();
  nameEl.textContent = FLAG_LABELS[action] || action;
  subEl.textContent = 'Sent to all connected panels';
}
