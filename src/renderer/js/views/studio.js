'use strict';

import * as ble from '../ble-client.js';
import { showToast } from '../components/toast.js';
import { confirmModal } from '../components/modal.js';
import { escapeHtml } from '../util.js';

let chosenFiles = [];

export async function render(section) {
  const [presets, devices] = await Promise.all([
    window.mvlp.invoke('ble:listPresetGifs'),
    window.mvlp.invoke('config:getDevices'),
  ]);
  const connectedIds = Object.keys(devices).filter((id) => ble.isConnected(id));

  section.innerHTML = `
    <div class="view-header">
      <div><h1>Studio</h1><p>Send images, animations and raw commands to your panels.</p></div>
    </div>

    <div class="card">
      <h3 class="card-title">Quick Send</h3>
      <p class="card-subtitle">Sends instantly to every connected panel.</p>
      <div class="preset-grid" id="preset-grid"></div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Test Effects</h3>
        <select id="test-target">${targetOptions(devices, connectedIds)}</select>
      </div>
      <p class="card-subtitle">Shows an effect on the panel the way it would appear for a real event, then puts the real display back.</p>
      <div class="effect-grid">
        ${TEST_EFFECTS.map((e) => `
          <div class="effect-row">
            <div class="row-label"><strong>${e.label}</strong><span>${e.hint}</span></div>
            <div class="effect-controls">
              ${e.input ? `<input type="${e.input.type || 'number'}" class="effect-input" data-input="${e.kind}" value="${e.input.value}" ${e.input.min !== undefined ? `min="${e.input.min}" max="${e.input.max}"` : ''} title="${e.input.title}" />` : ''}
              <button class="btn btn-sm" data-effect="${e.kind}">Show</button>
            </div>
          </div>`).join('')}
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Custom Send</h3>
        <select id="target-select">${targetOptions(devices, connectedIds)}</select>
      </div>
      <div class="field">
        <label>Files</label>
        <div class="file-chip-list" id="file-chips"></div>
        <button class="btn btn-sm" id="browse-btn">Browse…</button>
      </div>
      <div class="options-grid">
        <div class="row-between"><label style="font-size:13px;">Join images into one</label><label class="switch"><input type="checkbox" id="join-toggle" /><span class="track"></span></label></div>
        <div class="row-between"><label style="font-size:13px;">Animate stills (GIF)</label><label class="switch"><input type="checkbox" id="animate-toggle" /><span class="track"></span></label></div>
      </div>
      <div class="field" id="duration-field" hidden>
        <label>Frame duration (ms)</label>
        <input type="number" id="duration-input" value="100" min="10" />
      </div>
      <button class="btn btn-primary" id="send-files-btn">Send to Panel(s)</button>
    </div>

    <div class="card">
      <h3 class="card-title">Expert Command</h3>
      <p class="card-subtitle">Send a raw hex payload directly (e.g. <code>0400 0401</code>).</p>
      <div class="field-row">
        <input type="text" id="expert-hex" placeholder="AABBCCDD..." style="flex:1;" />
        <button class="btn" id="expert-send-btn">Send</button>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title">Danger Zone</h3>
      <button class="btn btn-danger btn-block" id="erase-all-btn">Erase All Buffers on All Panels</button>
    </div>
  `;

  renderPresetGrid(section, presets);
  section.querySelectorAll('[data-effect]').forEach((btn) => {
    btn.addEventListener('click', () => runTestEffect(section, btn.dataset.effect));
  });
  renderFileChips(section);

  section.querySelector('#browse-btn').addEventListener('click', async () => {
    const paths = await window.mvlp.invoke('app:chooseFiles');
    chosenFiles = paths;
    renderFileChips(section);
  });

  section.querySelector('#animate-toggle').addEventListener('change', (e) => {
    section.querySelector('#duration-field').hidden = !e.target.checked;
  });

  section.querySelector('#send-files-btn').addEventListener('click', () => sendFiles(section, devices));
  section.querySelector('#expert-send-btn').addEventListener('click', () => sendExpert(section));
  section.querySelector('#erase-all-btn').addEventListener('click', () => eraseAll(devices));
}

// Effects that can be shown on demand. `input` adds a number box (sector number, seconds).
const TEST_EFFECTS = [
  { kind: 'yellow-sector', label: 'Yellow flag with sector number', hint: 'Flashes, then settles on a still. Number 1-99.', input: { value: 14, min: 1, max: 99, title: 'Sector number' } },
  { kind: 'yellow-map', label: 'Yellow flag track map', hint: 'Big yellow flashes, then the circuit with flagged sectors lit. Needs a loaded session and a circuit Multiviewer has a layout for.', input: { type: 'text', value: '5,6', title: 'Flagged sector numbers, e.g. 5,6' } },
  { kind: 'yellow-sector-double', label: 'Double yellow with sector number', hint: 'Same as the yellow flag but flashing twice as fast.', input: { value: 14, min: 1, max: 99, title: 'Sector number' } },
  { kind: 'yellow-map-double', label: 'Double yellow track map', hint: 'The map version, flashing twice as fast.', input: { type: 'text', value: '5,6', title: 'Flagged sector numbers, e.g. 5,6' } },
  { kind: 'sc-ending', label: 'Safety car in this lap', hint: 'SC with a pulsing green border.' },
  { kind: 'vsc-ending', label: 'VSC ending', hint: 'VSC with a pulsing green border.' },
  { kind: 'fastest', label: 'Fastest lap', hint: 'Solid purple for 2 seconds.' },
  { kind: 'rain', label: 'Rain', hint: 'Shown for 10 seconds.' },
  { kind: 'pitclosed', label: 'Pit exit closed', hint: 'Shown for 10 seconds.' },
  { kind: 'chequered', label: 'Chequered flag', hint: 'Shown for 10 seconds.' },
  { kind: 'countdown', label: 'Session countdown', hint: 'Q1 countdown that runs by itself. Seconds to start.', input: { value: 30, min: 5, max: 600, title: 'Seconds until the start' } },
  { kind: 'delayed', label: 'Start delayed', hint: 'The hourglass shown when a start is delayed.' },
  { kind: 'startup', label: 'Startup animation', hint: 'What plays when a panel connects.' },
];

async function runTestEffect(section, kind) {
  const target = section.querySelector('#test-target').value;
  const input = section.querySelector(`[data-input="${kind}"]`);
  const arg = input ? (input.type === 'number' ? Number(input.value) : input.value) : undefined;
  const sent = await window.mvlp.invoke('test:effect', kind, arg, target === '__all__' ? undefined : target);
  if (sent === -1) showToast('Load a session in Multiviewer first: the track layout comes from there.', 'warning', 4000);
  else if (sent === -2) showToast('Multiviewer has no track layout for this circuit (new circuits are missing), so there is no map.', 'warning', 5000);
  else if (sent === -3) showToast('The track layout has not loaded yet. Check your internet connection and try again in a moment.', 'warning', 4000);
  else if (sent) showToast(`Showing on ${sent} panel${sent === 1 ? '' : 's'}.`, 'success', 1500);
  else showToast('No panel is connected right now.', 'warning');
}

function targetOptions(devices, connectedIds) {
  const opts = [`<option value="__all__">All Connected Panels (${connectedIds.length})</option>`];
  for (const [id, cfg] of Object.entries(devices)) {
    opts.push(`<option value="${id}" ${connectedIds.includes(id) ? '' : 'disabled'}>${escapeHtml(cfg.name || id)}${connectedIds.includes(id) ? '' : ' (offline)'}</option>`);
  }
  return opts.join('');
}

function renderPresetGrid(section, presets) {
  const grid = section.querySelector('#preset-grid');
  if (!presets.length) {
    grid.innerHTML = '<p class="help-text">No bundled GIFs found.</p>';
    return;
  }
  grid.innerHTML = presets
    .map((name) => `<div class="preset-tile" data-name="${name}"><span>${name}</span></div>`)
    .join('');
  grid.querySelectorAll('.preset-tile').forEach((tile) => {
    tile.addEventListener('click', async () => {
      const count = await window.mvlp.invoke('ble:sendGifPreset', tile.dataset.name);
      if (count) showToast(`Sent "${tile.dataset.name}" to ${count} panel(s).`, 'success', 2000);
      else showToast('No panel is connected right now.', 'warning');
    });
  });
}

function renderFileChips(section) {
  const el = section.querySelector('#file-chips');
  if (!chosenFiles.length) {
    el.innerHTML = '<span class="help-text">No files selected.</span>';
    return;
  }
  el.innerHTML = chosenFiles
    .map((p, i) => `<span class="file-chip">${escapeHtml(p.split(/[\\/]/).pop())}<button data-idx="${i}">&times;</button></span>`)
    .join('');
  el.querySelectorAll('button[data-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      chosenFiles.splice(Number(btn.dataset.idx), 1);
      renderFileChips(section);
    });
  });
}

async function sendFiles(section, devices) {
  if (!chosenFiles.length) {
    showToast('Choose at least one file first.', 'warning');
    return;
  }
  const target = section.querySelector('#target-select').value;
  const join = section.querySelector('#join-toggle').checked;
  const animate = section.querySelector('#animate-toggle').checked;
  const duration = parseInt(section.querySelector('#duration-input').value, 10) || 100;

  const isGif = animate || chosenFiles.some((p) => p.toLowerCase().endsWith('.gif'));
  const opts = {
    filePaths: chosenFiles,
    isGif,
    joinImageFiles: join,
    makeFromImage: animate ? duration : 0,
  };

  const targets = target === '__all__' ? Object.keys(devices).filter((id) => ble.isConnected(id)) : [target];
  if (!targets.length) {
    showToast('No connected panels to send to.', 'warning');
    return;
  }

  try {
    await Promise.all(targets.map((id) => window.mvlp.invoke('ble:writeFiles', id, opts)));
    showToast('Sent.', 'success');
  } catch (err) {
    showToast(`Send failed: ${err.message}`, 'error');
  }
}

async function sendExpert(section) {
  const hex = section.querySelector('#expert-hex').value.trim();
  if (!hex) return;
  const devices = await window.mvlp.invoke('config:getDevices');
  const targets = Object.keys(devices).filter((id) => ble.isConnected(id));
  if (!targets.length) {
    showToast('No connected panels.', 'warning');
    return;
  }
  try {
    await Promise.all(targets.map((id) => window.mvlp.invoke('ble:sendExpert', id, hex)));
    showToast('Expert payload sent.', 'success');
  } catch (err) {
    showToast(`Send failed: ${err.message}`, 'error');
  }
}

async function eraseAll(devices) {
  const ok = await confirmModal({
    title: 'Erase all buffers?',
    message: 'This clears every saved image/animation slot on every connected panel. This cannot be undone.',
    confirmLabel: 'Erase Everything',
    danger: true,
  });
  if (!ok) return;
  const targets = Object.keys(devices).filter((id) => ble.isConnected(id));
  await Promise.all(targets.map((id) => window.mvlp.invoke('ble:eraseAll', id)));
  showToast('Erase command sent to all panels.', 'success');
}
