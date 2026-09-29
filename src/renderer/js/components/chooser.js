'use strict';

import { openModal } from './modal.js';
import { escapeHtml } from '../util.js';

/**
 * Opens the device picker. Main scans while it's open and pushes the list of
 * nearby panels. Resolves with the picked device's name, or null if cancelled.
 */
export function pickDevice() {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'modal';
    el.innerHTML = `
      <h2>Select a Device</h2>
      <p class="help-text">Scanning for iPixel LED panels nearby. Make sure the panel is powered on.</p>
      <div class="chooser-list" id="chooser-list">
        <div class="chooser-empty"><span class="spinner"></span>&nbsp; Searching…</div>
      </div>
      <div class="modal-actions"><button class="btn" id="chooser-cancel" type="button">Cancel</button></div>
    `;
    const listEl = el.querySelector('#chooser-list');
    let picked = null;

    function render(devices) {
      if (!devices || !devices.length) {
        listEl.innerHTML = '<div class="chooser-empty"><span class="spinner"></span>&nbsp; Searching…</div>';
        return;
      }
      listEl.innerHTML = '';
      devices.forEach((d) => {
        const item = document.createElement('div');
        item.className = 'chooser-item';
        item.innerHTML = `<span class="device-dot online"></span><span>${escapeHtml(d.deviceName || 'Unknown device')}</span>`;
        item.onclick = () => {
          picked = d.deviceId;
          close();
        };
        listEl.appendChild(item);
      });
    }

    const unsubscribe = window.mvlp.on('ble:chooserDevices', render);

    const { close } = openModal(el, {
      onClose: async () => {
        unsubscribe();
        await window.mvlp.invoke('ble:scanStop').catch(() => {});
        resolve(picked);
      },
    });
    el.querySelector('#chooser-cancel').onclick = () => close();

    window.mvlp.invoke('ble:scanStart').catch((err) => {
      listEl.innerHTML = `<div class="chooser-empty">${escapeHtml(err.message || 'Could not start scanning.')}</div>`;
    });
  });
}
