'use strict';

import { showToast } from '../components/toast.js';
import { confirmModal } from '../components/modal.js';
import { openSpotifyCredentialsModal } from './spotify-credentials-modal.js';
import { watchUpdates, updateText, bindUpdateButton } from '../components/updates.js';

export async function render(section) {
  const [settings, version, spotifyState, creds] = await Promise.all([
    window.mvlp.invoke('config:getSettings'),
    window.mvlp.invoke('app:getVersion'),
    window.mvlp.invoke('spotify:getState'),
    window.mvlp.invoke('config:getSpotifyCredentials'),
  ]);

  section.innerHTML = `
    <div class="view-header"><div><h1>Settings</h1><p>Behavior, appearance and integrations.</p></div></div>

    <div class="card">
      <h3 class="card-title">Appearance</h3>
      <div class="row-between">
        <div class="row-label"><strong>Theme</strong><span>Choose how MVLP looks.</span></div>
        <select id="theme-select">
          <option value="dark" ${settings.theme !== 'light' ? 'selected' : ''}>Dark</option>
          <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>Light</option>
        </select>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title">Startup &amp; Behavior</h3>
      ${toggleRow('launch-toggle', 'Launch at login', 'Start MVLP automatically when you sign in.', settings.launchAtLogin)}
      ${toggleRow('tray-toggle', 'Minimize to tray on close', 'Keep running in the background instead of quitting.', settings.minimizeToTray)}
      ${toggleRow('startup-toggle', 'Startup animation', 'Play a short animation on a panel when it connects.', settings.startupAnimation !== false)}
      ${toggleRow('notif-toggle', 'Desktop notifications', 'Notify on connects, disconnects and errors.', settings.notifications)}
    </div>

    <div class="card">
      <h3 class="card-title">Multiviewer</h3>
      <div class="row-between">
        <div class="row-label"><strong>Yellow flag display</strong><span>Show the flagged sector as a number, or as a small track map with the flagged sectors lit. Circuits without a layout (brand-new tracks) fall back to the number.</span></div>
        <select id="yellow-display-select">
          <option value="number" ${settings.yellowDisplay !== 'map' ? 'selected' : ''}>Sector number</option>
          <option value="map" ${settings.yellowDisplay === 'map' ? 'selected' : ''}>Track map</option>
        </select>
      </div>
      ${toggleRow('sector-toggle', 'Full sectors for yellow flags', 'Show sector 1–3 on the panel instead of the ~20 mini-sector numbers. Full sectors are estimated from the track layout.', settings.fullSectorYellows)}
    </div>

    <div class="card">
      <h3 class="card-title">Idle screens</h3>
      <p class="help-text">When no session is live and nothing is playing on Spotify, the panels rotate through these screens. Playing a track or starting a session takes over at once.</p>
      ${toggleRow('idle-toggle', 'Show idle screens', 'Otherwise the panel keeps its last display or its own clock.', settings.idleEnabled !== false)}
      ${toggleRow('idle-next-toggle', 'Next race', 'The circuit with a countdown, then the date.', settings.idleNextRace !== false)}
      ${toggleRow('idle-podium-toggle', 'Last podium', 'The top three of the last race.', settings.idleLastPodium !== false)}
      ${toggleRow('idle-standings-toggle', 'Standings', 'Top three drivers and teams in the championship.', settings.idleStandings !== false)}
      ${toggleRow('night-toggle', 'Night dimming', 'Dim the panels during the night hours, only while the idle screens are showing.', settings.nightDimming !== false)}
      <div class="row-between">
        <div class="row-label"><strong>Night hours</strong><span>From and to, in your local time.</span></div>
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="time" id="night-start" value="${settings.nightStart || '22:00'}" />
          <input type="time" id="night-end" value="${settings.nightEnd || '07:00'}" />
        </div>
      </div>
      <div class="row-between">
        <div class="row-label"><strong>Night brightness</strong><span id="night-level-label">${settings.nightBrightness ?? 20}%</span></div>
        <input type="range" id="night-level" min="1" max="100" value="${settings.nightBrightness ?? 20}" />
      </div>
    </div>

    <div class="card">
      <h3 class="card-title">Spotify</h3>
      <div class="row-between">
        <div class="row-label"><strong>Status</strong><span>${spotifyState.enabled ? 'Connected' : 'Not connected'}</span></div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-sm" id="spotify-edit-btn">Edit Credentials</button>
          ${spotifyState.enabled ? '<button class="btn btn-sm btn-danger" id="spotify-disconnect-btn">Disconnect</button>' : ''}
        </div>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title">About</h3>
      <p class="help-text">MVLP v${version} — connects iPixel LED panels to Multiviewer for F1 and Spotify.</p>
      ${toggleRow('update-toggle', 'Check for updates', 'Look for a new version on GitHub at launch and every few hours.', settings.autoUpdateCheck !== false)}
      <div class="row-between">
        <div class="row-label"><strong>Updates</strong><span id="update-status">Not checked yet.</span></div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-sm btn-primary" id="update-action-btn" hidden></button>
          <button class="btn btn-sm" id="update-check-btn">Check now</button>
        </div>
      </div>
      <div style="display:flex;gap:10px;">
        <button class="btn btn-sm" id="link-repo">GitHub Repository</button>
        <button class="btn btn-sm" id="link-mv">Multiviewer</button>
      </div>
    </div>
  `;

  section.querySelector('#theme-select').addEventListener('change', async (e) => {
    await window.mvlp.invoke('config:setSetting', 'theme', e.target.value);
    document.documentElement.dataset.theme = e.target.value;
  });

  bindToggle(section, 'launch-toggle', 'launchAtLogin');
  bindToggle(section, 'tray-toggle', 'minimizeToTray');
  bindToggle(section, 'startup-toggle', 'startupAnimation');
  section.querySelector('#yellow-display-select').addEventListener('change', (e) => {
    window.mvlp.invoke('config:setSetting', 'yellowDisplay', e.target.value);
  });
  bindToggle(section, 'notif-toggle', 'notifications');
  bindToggle(section, 'sector-toggle', 'fullSectorYellows');
  bindToggle(section, 'idle-toggle', 'idleEnabled');
  bindToggle(section, 'idle-next-toggle', 'idleNextRace');
  bindToggle(section, 'idle-podium-toggle', 'idleLastPodium');
  bindToggle(section, 'idle-standings-toggle', 'idleStandings');
  bindToggle(section, 'night-toggle', 'nightDimming');
  for (const [id, key] of [['night-start', 'nightStart'], ['night-end', 'nightEnd']]) {
    section.querySelector(`#${id}`).addEventListener('change', (e) => {
      if (e.target.value) window.mvlp.invoke('config:setSetting', key, e.target.value);
    });
  }
  const level = section.querySelector('#night-level');
  level.addEventListener('input', () => { section.querySelector('#night-level-label').textContent = `${level.value}%`; });
  level.addEventListener('change', () => window.mvlp.invoke('config:setSetting', 'nightBrightness', Number(level.value)));

  bindToggle(section, 'update-toggle', 'autoUpdateCheck');
  const statusEl = section.querySelector('#update-status');
  const actionBtn = section.querySelector('#update-action-btn');
  const checkBtn = section.querySelector('#update-check-btn');
  const unwatch = watchUpdates((s) => {
    if (!statusEl.isConnected) { unwatch(); return; }
    statusEl.textContent = updateText(s) || `Version ${s.currentVersion}. ${s.checkedAt ? 'Up to date.' : 'Not checked yet.'}`;
    bindUpdateButton(actionBtn, s);
    if (s.status === 'downloading') actionBtn.hidden = true;
    checkBtn.disabled = ['checking', 'downloading'].includes(s.status);
  });
  actionBtn.addEventListener('click', () => window.mvlp.invoke(actionBtn.dataset.action));
  checkBtn.addEventListener('click', () => window.mvlp.invoke('updater:check'));

  section.querySelector('#spotify-edit-btn').addEventListener('click', () => {
    openSpotifyCredentialsModal({ clientId: creds.clientId, onSaved: () => render(section) });
  });
  section.querySelector('#spotify-disconnect-btn')?.addEventListener('click', async () => {
    await window.mvlp.invoke('spotify:disconnect');
    render(section);
  });

  section.querySelector('#link-repo').addEventListener('click', () => {
    window.mvlp.invoke('app:openExternal', 'https://github.com/dekiller82/MVLP-2.0');
  });
  section.querySelector('#link-mv').addEventListener('click', () => {
    window.mvlp.invoke('app:openExternal', 'https://multiviewer.app/');
  });
}

function toggleRow(id, title, sub, checked) {
  return `<div class="row-between">
    <div class="row-label"><strong>${title}</strong><span>${sub}</span></div>
    <label class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} /><span class="track"></span></label>
  </div>`;
}

function bindToggle(section, elementId, settingKey) {
  section.querySelector(`#${elementId}`).addEventListener('change', async (e) => {
    await window.mvlp.invoke('config:setSetting', settingKey, e.target.checked);
    if (settingKey === 'notifications') showToast('Preference saved.', 'success', 1500);
  });
}
