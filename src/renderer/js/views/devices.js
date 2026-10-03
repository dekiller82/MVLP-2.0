'use strict';

import * as ble from '../ble-client.js';
import { showToast } from '../components/toast.js';
import { openModal, confirmModal } from '../components/modal.js';
import { pickDevice } from '../components/chooser.js';
import { PIXEL_STYLES, DOT_DEFAULTS, resolveDots } from '../components/dotmask.js';
import { escapeHtml } from '../util.js';

const isEmulated = (id) => String(id).startsWith('Emulator-');

let unsubscribers = [];
let openWindows = new Set(); // emulated panels whose window is open

export async function render(section) {
  section.innerHTML = `
    <div class="view-header">
      <div>
        <h1>Devices</h1>
        <p>Connect and configure your iPixel LED panels.</p>
      </div>
      <div class="device-actions">
        <button class="btn" id="add-emulator-btn" title="A virtual panel in its own window, for when you have no LED panel">+ Add Emulated Panel</button>
        <button class="btn btn-primary" id="add-device-btn">+ Add Device</button>
      </div>
    </div>
    <div id="device-list" class="grid grid-2"></div>
  `;

  // Wire up interaction before the (data-dependent) list render, so a bad
  // config for one device can't take the "Add Device" button down with it.
  section.querySelector('#add-device-btn').addEventListener('click', () => addDevice(section));
  section.querySelector('#add-emulator-btn').addEventListener('click', () => addEmulator(section));

  unsubscribers.forEach((fn) => fn());
  unsubscribers = [
    window.mvlp.on('device:connected', () => refresh(section)),
    window.mvlp.on('device:disconnected', () => refresh(section)),
    window.mvlp.on('device:connect-failed', () => refresh(section)),
    window.mvlp.on('emulator:windows', () => refresh(section)),
  ];

  await refresh(section);
}

async function refresh(section) {
  const devices = await window.mvlp.invoke('config:getDevices');
  openWindows = new Set(await window.mvlp.invoke('emulator:getWindows'));
  const listEl = section.querySelector('#device-list');
  const entries = Object.entries(devices);

  if (!entries.length) {
    listEl.className = '';
    listEl.innerHTML = `
      <div class="empty-state">
        <h3>No panels yet</h3>
        <p>Click "Add Device" and pick your iPixel panel from the list, or "Add Emulated Panel" to try MVLP without one.</p>
      </div>`;
    return;
  }

  listEl.className = 'grid grid-2';
  listEl.innerHTML = '';
  for (const [id, config] of entries) {
    try {
      listEl.appendChild(buildDeviceCard(id, config, section));
    } catch (err) {
      console.error(`Failed to render device card for ${id}:`, err);
    }
  }
}

const DEVICE_CONFIG_DEFAULTS = {
  buffer: 1, autoResize: true, width: 32, height: 32, anchor: 0x33,
  brightness: 100, flipDisplay: false, clockStyle: 7,
};

const DOT_SLIDERS = [
  { key: 'dotSize', label: 'Dot size', min: 20, max: 140, hint: 'How much of each pixel the lit dot fills' },
  { key: 'softness', label: 'Edge softness', min: 0, max: 100, hint: 'Hard edge to a faded edge' },
  { key: 'maskStrength', label: 'Gap darkness', min: 0, max: 100, hint: 'How dark the space between the dots is' },
  { key: 'boost', label: 'Brightness lift', min: 100, max: 200, hint: 'Makes up for the light the mask hides' },
];

function dotMaskControls(dots) {
  const flat = dots.style === 'flat';
  return `
    <div class="field dot-mask">
      <div class="row-between"><label style="margin:0;"><strong>Dot mask</strong></label><button class="btn btn-sm" data-action="reset-dots">Reset</button></div>
      ${DOT_SLIDERS.filter((d) => !(flat && d.key !== 'boost')).map((d) => `
      <div class="dot-slider" title="${d.hint}">
        <div class="row-between"><label style="margin:0;">${d.label}</label><span data-role="dot-${d.key}" style="font-size:12px;color:var(--text-dim);">${Math.round(dots[d.key])}%</span></div>
        <input type="range" min="${d.min}" max="${d.max}" data-dot="${d.key}" value="${dots[d.key]}" />
      </div>`).join('')}
    </div>`;
}

/** An emulated panel has no Save button: every setting is stored as soon as it changes, and the open window follows. */
function wireEmulatedSettings(id, card, section) {
  const save = (patch) => window.mvlp.invoke('config:setDeviceOption', id, patch).catch((err) => showToast(err.message, 'error'));
  for (const name of ['width', 'height']) {
    const input = card.querySelector(`[data-field="${name}"]`);
    input.addEventListener('change', () => {
      const value = parseInt(input.value, 10);
      if (value >= 1) save({ [name]: value });
      else showToast('The size must be at least 1 pixel.', 'error');
    });
  }
  for (const name of ['autoResize', 'onlyWithMv']) {
    const input = card.querySelector(`[data-field="${name}"]`);
    input.addEventListener('change', () => save({ [name]: input.checked }));
  }
  wireDotMask(id, card, section);
}

/** The dot mask applies as it is changed, so the open window can be watched. Changing the style starts from that style's defaults. */
function wireDotMask(id, card, section) {
  const save = (patch) => window.mvlp.invoke('config:setDeviceOption', id, patch);
  card.querySelectorAll('[data-dot]').forEach((input) => {
    input.addEventListener('input', () => {
      card.querySelector(`[data-role="dot-${input.dataset.dot}"]`).textContent = `${input.value}%`;
    });
    input.addEventListener('change', () => save({ [input.dataset.dot]: Number(input.value) }));
  });
  card.querySelector('[data-field="pixelStyle"]').addEventListener('change', async (e) => {
    await save({ pixelStyle: e.target.value, ...DOT_DEFAULTS[e.target.value] });
    refresh(section);
  });
  card.querySelector('[data-action="reset-dots"]').addEventListener('click', async () => {
    const style = card.querySelector('[data-field="pixelStyle"]').value;
    await save({ ...DOT_DEFAULTS[style] });
    refresh(section);
  });
}

function buildDeviceCard(id, rawConfig, section) {
  // Defensive: configs saved before a field existed (or edited by hand)
  // shouldn't crash the whole view - fill in anything missing.
  const config = { ...DEVICE_CONFIG_DEFAULTS, ...rawConfig };
  const connected = ble.isConnected(id);
  const emulated = isEmulated(id);
  const card = document.createElement('div');
  card.className = 'card device-card';
  card.innerHTML = `
    <div class="device-card-head">
      <span class="device-dot ${connected ? 'online' : ''}"></span>
      <div>
        <div class="device-name">${escapeHtml(config.name || id)}${emulated ? ' <span class="badge-emulated">Emulated</span>' : ''}</div>
        <div class="device-id">${connected ? (emulated ? 'On' : 'Connected') : (emulated ? 'Off' : 'Not connected')}</div>
      </div>
      <div class="device-actions">
        <button class="btn btn-sm" data-action="toggle-connect">${connected ? (emulated ? 'Turn off' : 'Disconnect') : (emulated ? 'Turn on' : 'Connect')}</button>
        <button class="icon-btn" data-action="remove" title="Remove device">&times;</button>
      </div>
    </div>
    <hr class="divider" />
    <div class="options-grid">
      <div class="field"><label>Width (px)</label><input type="number" min="1" data-field="width" value="${config.width}" /></div>
      <div class="field"><label>Height (px)</label><input type="number" min="1" data-field="height" value="${config.height}" /></div>
      ${emulated ? `
      <div class="field"><label>Pixel style</label>
        <select data-field="pixelStyle">${PIXEL_STYLES.map(([key, label]) => `<option value="${key}" ${key === (config.pixelStyle || 'round') ? 'selected' : ''}>${label}</option>`).join('')}</select>
      </div>` : `
      <div class="field"><label>Start Buffer (1-255)</label><input type="number" min="1" max="255" data-field="buffer" value="${config.buffer}" /></div>
      <div class="field"><label>Anchor (hex)</label><input type="text" data-field="anchor" value="0x${config.anchor.toString(16)}" /></div>
      <div class="field"><label>Exit Clock Style</label>
        <select data-field="clockStyle">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}" ${n === config.clockStyle ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </div>`}
      <div class="field">
        <label>Auto-resize to panel size</label>
        <label class="switch"><input type="checkbox" data-field="autoResize" ${config.autoResize ? 'checked' : ''} /><span class="track"></span></label>
      </div>
    </div>
    ${emulated ? '' : `<div class="field">
      <div class="row-between"><label style="margin:0;">Brightness</label><span data-role="brightness-value" style="font-size:12px;color:var(--text-dim);">${config.brightness}%</span></div>
      <input type="range" min="1" max="100" data-field="brightness" value="${config.brightness}" ${connected ? '' : 'disabled'} />
    </div>`}
    ${emulated ? '' : `<div class="row-between">
      <div class="row-label"><strong>Flip Display 180°</strong></div>
      <label class="switch"><input type="checkbox" data-field="flipDisplay" ${config.flipDisplay ? 'checked' : ''} ${connected ? '' : 'disabled'} /><span class="track"></span></label>
    </div>`}
    ${emulated ? dotMaskControls(resolveDots(config)) : ''}
    ${emulated ? `
    <div class="row-between">
      <div class="row-label"><strong>Only open while Multiviewer is running</strong></div>
      <label class="switch"><input type="checkbox" data-field="onlyWithMv" ${config.onlyWithMv ? 'checked' : ''} /><span class="track"></span></label>
    </div>` : ''}
    <div class="modal-actions" style="justify-content:flex-start;">
      ${emulated ? '' : '<button class="btn btn-primary btn-sm" data-action="save">Save Options</button>'}
      ${emulated
        ? `<button class="btn btn-sm" data-action="toggle-window" ${connected ? '' : 'disabled'}>${openWindows.has(id) ? 'Close window' : 'Open window'}</button>`
        : `<button class="btn btn-sm" data-action="erase" ${connected ? '' : 'disabled'}>Erase Buffers</button>`}
    </div>
  `;

  card.querySelector('[data-action="toggle-connect"]').addEventListener('click', () => toggleConnect(id, section));
  card.querySelector('[data-action="remove"]').addEventListener('click', () => removeDevice(id, card));
  card.querySelector('[data-action="save"]')?.addEventListener('click', () => saveOptions(id, card));
  card.querySelector('[data-action="erase"]')?.addEventListener('click', () => eraseDevice(id));
  card.querySelector('[data-action="toggle-window"]')?.addEventListener('click', () => window.mvlp.invoke('emulator:setWindow', id, !openWindows.has(id)));

  const brightnessInput = card.querySelector('[data-field="brightness"]'); // real panels only
  brightnessInput?.addEventListener('input', () => {
    card.querySelector('[data-role="brightness-value"]').textContent = `${brightnessInput.value}%`;
  });
  brightnessInput?.addEventListener('change', async () => {
    await window.mvlp.invoke('ble:setBrightness', id, Number(brightnessInput.value));
  });

  if (emulated) wireEmulatedSettings(id, card, section);

  const flipInput = card.querySelector('[data-field="flipDisplay"]'); // real panels only
  flipInput?.addEventListener('change', async () => {
    await window.mvlp.invoke('ble:setFlip', id, flipInput.checked);
  });

  return card;
}

async function toggleConnect(id, section) {
  if (ble.isConnected(id)) {
    await ble.disconnectDevice(id);
    return;
  }
  try {
    await ble.connectDevice(id);
  } catch (err) {
    showToast(`Could not connect: ${err.message}`, 'error');
  }
}

async function removeDevice(id, card) {
  const ok = await confirmModal({
    title: 'Remove this device?',
    message: 'It will be disconnected and its saved settings deleted.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  await window.mvlp.invoke('ble:forgetDevice', id);
  card.remove();
}

async function saveOptions(id, card) {
  try {
    const field = (name) => card.querySelector(`[data-field="${name}"]`);
    const patch = {
      width: parseInt(field('width').value, 10),
      height: parseInt(field('height').value, 10),
      autoResize: field('autoResize').checked,
    };
    patch.buffer = parseInt(field('buffer').value, 10);
    patch.anchor = parseInt(field('anchor').value, 0);
    patch.clockStyle = parseInt(field('clockStyle').value, 10);
    if (Object.values(patch).some((v) => typeof v === 'number' && Number.isNaN(v))) throw new Error('Please check your numeric inputs.');
    await window.mvlp.invoke('config:setDeviceOption', id, patch);
    showToast('Device options saved.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function eraseDevice(id) {
  const ok = await confirmModal({
    title: 'Erase all buffers?',
    message: 'This clears every saved image/animation slot on this panel.',
    confirmLabel: 'Erase',
    danger: true,
  });
  if (!ok) return;
  await window.mvlp.invoke('ble:eraseAll', id);
  showToast('Erase command sent.', 'success');
}

async function addEmulator(section) {
  try {
    const id = await window.mvlp.invoke('emulator:add');
    await refresh(section);
    const dims = await promptDimensions('Emulated panel');
    if (dims) {
      await window.mvlp.invoke('config:setDeviceOption', id, { width: dims.width, height: dims.height });
      await refresh(section);
    }
  } catch (err) {
    showToast(`Could not add the emulated panel: ${err.message}`, 'error');
  }
}

async function addDevice(section) {
  const key = await pickDevice();
  if (!key) return;

  // The device's advertised name is our stable identity. Defaults (32x32) are
  // used for a brand new device and can be tuned afterward from its card, or
  // via the dimensions prompt shown right after a successful first connection.
  const existing = await window.mvlp.invoke('config:getDevice', key);
  const isNew = !existing;

  try {
    await ble.connectDevice(key);
  } catch (err) {
    showToast(`Could not connect: ${err.message}`, 'error');
    return;
  }

  await refresh(section);

  if (isNew) {
    const dims = await promptDimensions(key);
    if (dims) {
      await window.mvlp.invoke('config:setDeviceOption', key, {
        name: key,
        width: dims.width,
        height: dims.height,
      });
      await refresh(section);
    }
  }
}

function promptDimensions(name) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'modal';
    el.style.maxWidth = '380px';
    el.innerHTML = `
      <h2>Connected! Set panel dimensions</h2>
      <p class="help-text">${escapeHtml(name || 'New device')} — enter the resolution of your LED panel. You can change this later from its card.</p>
      <div class="field-row">
        <div class="field"><label>Width</label><input type="number" id="dim-width" value="32" min="1" /></div>
        <div class="field"><label>Height</label><input type="number" id="dim-height" value="32" min="1" /></div>
      </div>
      <div class="modal-actions">
        <button class="btn" data-action="cancel">Skip</button>
        <button class="btn btn-primary" data-action="confirm">Save</button>
      </div>
    `;
    const { close } = openModal(el, { onClose: () => resolve(null) });
    el.querySelector('[data-action="cancel"]').onclick = () => close();
    el.querySelector('[data-action="confirm"]').onclick = () => {
      const width = parseInt(el.querySelector('#dim-width').value, 10);
      const height = parseInt(el.querySelector('#dim-height').value, 10);
      if (!width || !height) return;
      resolve({ width, height });
      close();
    };
  });
}
