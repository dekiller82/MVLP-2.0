'use strict';

import * as ble from '../ble-client.js';
import { showToast } from '../components/toast.js';
import { openModal, confirmModal } from '../components/modal.js';
import { pickDevice } from '../components/chooser.js';
import { escapeHtml } from '../util.js';

let unsubscribers = [];

export async function render(section) {
  section.innerHTML = `
    <div class="view-header">
      <div>
        <h1>Devices</h1>
        <p>Connect and configure your iPixel LED panels.</p>
      </div>
      <button class="btn btn-primary" id="add-device-btn">+ Add Device</button>
    </div>
    <div id="device-list" class="grid grid-2"></div>
  `;

  // Wire up interaction before the (data-dependent) list render, so a bad
  // config for one device can't take the "Add Device" button down with it.
  section.querySelector('#add-device-btn').addEventListener('click', () => addDevice(section));

  unsubscribers.forEach((fn) => fn());
  unsubscribers = [
    window.mvlp.on('device:connected', () => refresh(section)),
    window.mvlp.on('device:disconnected', () => refresh(section)),
    window.mvlp.on('device:connect-failed', () => refresh(section)),
  ];

  await refresh(section);
}

async function refresh(section) {
  const devices = await window.mvlp.invoke('config:getDevices');
  const listEl = section.querySelector('#device-list');
  const entries = Object.entries(devices);

  if (!entries.length) {
    listEl.className = '';
    listEl.innerHTML = `
      <div class="empty-state">
        <h3>No panels yet</h3>
        <p>Click "Add Device" and pick your iPixel panel from the list.</p>
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

function buildDeviceCard(id, rawConfig, section) {
  // Defensive: configs saved before a field existed (or edited by hand)
  // shouldn't crash the whole view - fill in anything missing.
  const config = { ...DEVICE_CONFIG_DEFAULTS, ...rawConfig };
  const connected = ble.isConnected(id);
  const card = document.createElement('div');
  card.className = 'card device-card';
  card.innerHTML = `
    <div class="device-card-head">
      <span class="device-dot ${connected ? 'online' : ''}"></span>
      <div>
        <div class="device-name">${escapeHtml(config.name || id)}</div>
        <div class="device-id">${connected ? 'Connected' : 'Not connected'}</div>
      </div>
      <div class="device-actions">
        <button class="btn btn-sm" data-action="toggle-connect">${connected ? 'Disconnect' : 'Connect'}</button>
        <button class="icon-btn" data-action="remove" title="Remove device">&times;</button>
      </div>
    </div>
    <hr class="divider" />
    <div class="options-grid">
      <div class="field"><label>Width (px)</label><input type="number" min="1" data-field="width" value="${config.width}" /></div>
      <div class="field"><label>Height (px)</label><input type="number" min="1" data-field="height" value="${config.height}" /></div>
      <div class="field"><label>Start Buffer (1-255)</label><input type="number" min="1" max="255" data-field="buffer" value="${config.buffer}" /></div>
      <div class="field"><label>Anchor (hex)</label><input type="text" data-field="anchor" value="0x${config.anchor.toString(16)}" /></div>
      <div class="field"><label>Exit Clock Style</label>
        <select data-field="clockStyle">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}" ${n === config.clockStyle ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </div>
      <div class="field">
        <label>Auto-resize to panel size</label>
        <label class="switch"><input type="checkbox" data-field="autoResize" ${config.autoResize ? 'checked' : ''} /><span class="track"></span></label>
      </div>
    </div>
    <div class="field">
      <div class="row-between"><label style="margin:0;">Brightness</label><span data-role="brightness-value" style="font-size:12px;color:var(--text-dim);">${config.brightness}%</span></div>
      <input type="range" min="1" max="100" data-field="brightness" value="${config.brightness}" ${connected ? '' : 'disabled'} />
    </div>
    <div class="row-between">
      <div class="row-label"><strong>Flip Display 180°</strong></div>
      <label class="switch"><input type="checkbox" data-field="flipDisplay" ${config.flipDisplay ? 'checked' : ''} ${connected ? '' : 'disabled'} /><span class="track"></span></label>
    </div>
    <div class="modal-actions" style="justify-content:flex-start;">
      <button class="btn btn-primary btn-sm" data-action="save">Save Options</button>
      <button class="btn btn-sm" data-action="erase" ${connected ? '' : 'disabled'}>Erase Buffers</button>
    </div>
  `;

  card.querySelector('[data-action="toggle-connect"]').addEventListener('click', () => toggleConnect(id, section));
  card.querySelector('[data-action="remove"]').addEventListener('click', () => removeDevice(id, card));
  card.querySelector('[data-action="save"]').addEventListener('click', () => saveOptions(id, card));
  card.querySelector('[data-action="erase"]').addEventListener('click', () => eraseDevice(id));

  const brightnessInput = card.querySelector('[data-field="brightness"]');
  brightnessInput.addEventListener('input', () => {
    card.querySelector('[data-role="brightness-value"]').textContent = `${brightnessInput.value}%`;
  });
  brightnessInput.addEventListener('change', async () => {
    await window.mvlp.invoke('ble:setBrightness', id, Number(brightnessInput.value));
  });

  const flipInput = card.querySelector('[data-field="flipDisplay"]');
  flipInput.addEventListener('change', async () => {
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
    const patch = {
      width: parseInt(card.querySelector('[data-field="width"]').value, 10),
      height: parseInt(card.querySelector('[data-field="height"]').value, 10),
      buffer: parseInt(card.querySelector('[data-field="buffer"]').value, 10),
      anchor: parseInt(card.querySelector('[data-field="anchor"]').value, 0),
      clockStyle: parseInt(card.querySelector('[data-field="clockStyle"]').value, 10),
      autoResize: card.querySelector('[data-field="autoResize"]').checked,
    };
    if (Object.values(patch).some((v) => Number.isNaN(v))) throw new Error('Please check your numeric inputs.');
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
