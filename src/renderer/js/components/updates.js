'use strict';

/**
 * Update UI shared by the sidebar banner and the Settings card. Both are drawn from the same
 * state the main process publishes ("updater:state").
 */

let state = null;
const listeners = new Set();

export async function initUpdates() {
  state = await window.mvlp.invoke('updater:getState');
  window.mvlp.on('updater:state', (next) => {
    state = next;
    listeners.forEach((fn) => fn(state));
  });
}

/** Calls `fn` now and on every change; returns an unsubscribe function. */
export function watchUpdates(fn) {
  listeners.add(fn);
  if (state) fn(state);
  return () => listeners.delete(fn);
}

/** One line describing the state, or '' when there is nothing to say. */
export function updateText(s) {
  switch (s.status) {
    case 'available': return `Version ${s.version} is available.`;
    case 'downloading': return `Downloading version ${s.version}: ${s.progress}%`;
    case 'downloaded': return `Version ${s.version} is ready to install.`;
    case 'checking': return 'Checking for updates...';
    default: return s.message || '';
  }
}

/** The button that fits the state: update (where the app can install itself), download page, or restart. */
export function updateButton(s) {
  if (s.status === 'downloaded') return { label: 'Restart and install', action: 'updater:install' };
  if (s.status === 'available') {
    return s.canInstall
      ? { label: 'Update now', action: 'updater:download' }
      : { label: 'Download from GitHub', action: 'updater:openRelease' };
  }
  if (s.status === 'error' && s.version) return { label: 'Download from GitHub', action: 'updater:openRelease' };
  return null;
}

export function bindUpdateButton(el, s) {
  const btn = updateButton(s);
  el.hidden = !btn;
  if (!btn) return;
  el.textContent = btn.label;
  el.dataset.action = btn.action;
  el.disabled = false;
}

export function setupUpdateBanner() {
  const banner = document.getElementById('update-banner');
  const text = document.getElementById('update-banner-text');
  const button = document.getElementById('update-banner-btn');
  button.addEventListener('click', () => {
    if (button.dataset.action) window.mvlp.invoke(button.dataset.action);
  });
  watchUpdates((s) => {
    // The banner is for something to act on; "up to date" and check errors stay in Settings.
    const show = ['available', 'downloading', 'downloaded'].includes(s.status) || (s.status === 'error' && s.version);
    banner.hidden = !show;
    if (!show) return;
    text.textContent = updateText(s) || `Version ${s.version} is available.`;
    bindUpdateButton(button, s);
    if (s.status === 'downloading') button.hidden = true;
  });
}
