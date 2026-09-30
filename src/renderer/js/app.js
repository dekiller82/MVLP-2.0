'use strict';

import * as ble from './ble-client.js';
import { showToast } from './components/toast.js';
import * as dashboard from './views/dashboard.js';
import * as devices from './views/devices.js';
import * as studio from './views/studio.js';
import * as settingsView from './views/settings.js';
import { renderOnboarding } from './views/onboarding.js';
import { initUpdates, setupUpdateBanner } from './components/updates.js';
import { escapeHtml } from './util.js';

const views = {
  dashboard: { section: document.getElementById('view-dashboard'), module: dashboard },
  devices: { section: document.getElementById('view-devices'), module: devices },
  studio: { section: document.getElementById('view-studio'), module: studio },
  settings: { section: document.getElementById('view-settings'), module: settingsView },
};

function showView(name) {
  for (const [key, view] of Object.entries(views)) {
    const active = key === name;
    view.section.hidden = !active;
    if (active) view.module.render(view.section);
  }
  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === name);
  });
}

function setupNav() {
  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
}

function setupLogDrawer() {
  const drawer = document.getElementById('log-drawer');
  const entriesEl = document.getElementById('log-entries');
  const MAX_LINES = 300;

  function appendEntry(entry) {
    const line = document.createElement('div');
    line.className = `log-line ${entry.level}`;
    const time = new Date(entry.time).toLocaleTimeString();
    line.innerHTML = `<span class="log-time">${time}</span><span class="log-scope">${entry.scope}</span>${escapeHtml(entry.message)}`;
    entriesEl.appendChild(line);
    while (entriesEl.children.length > MAX_LINES) entriesEl.removeChild(entriesEl.firstChild);
    entriesEl.scrollTop = entriesEl.scrollHeight;
  }

  window.mvlp.invoke('log:getEntries').then((entries) => entries.forEach(appendEntry));
  window.mvlp.on('log:entry', appendEntry);

  document.getElementById('toggle-log-btn').addEventListener('click', () => {
    drawer.hidden = !drawer.hidden;
  });
  document.getElementById('close-log-btn').addEventListener('click', () => {
    drawer.hidden = true;
  });
}

function setupGlobalStatus() {
  const pill = document.getElementById('global-status-pill');
  const text = document.getElementById('global-status-text');

  window.mvlp.on('mv:status', (state) => {
    pill.classList.remove('is-connected', 'is-warning', 'is-error');
    if (state === 'connected') {
      pill.classList.add('is-connected');
      text.textContent = 'Multiviewer connected';
    } else if (state === 'retrying') {
      pill.classList.add('is-warning');
      text.textContent = 'Reconnecting to Multiviewer…';
    } else {
      text.textContent = 'Idle';
    }
  });
}

function setupDeviceToasts() {
  window.mvlp.on('device:connected', ({ name, id }) => showToast(`Connected to ${name || id}`, 'success'));
  window.mvlp.on('device:disconnected', ({ id }) => showToast(`Device disconnected (${id.slice(0, 8)}…)`, 'warning'));
  window.mvlp.on('device:connect-failed', ({ id, message }) => showToast(`Connection failed: ${message || id}`, 'error'));
}

async function applyTheme() {
  const settings = await window.mvlp.invoke('config:getSettings');
  document.documentElement.dataset.theme = settings.theme === 'light' ? 'light' : 'dark';
}

async function bootstrap() {
  await applyTheme();
  setupNav();
  setupLogDrawer();
  setupGlobalStatus();
  await initUpdates();
  setupUpdateBanner();
  setupDeviceToasts();
  // Main reconnects remembered panels on its own; just mirror what's live.
  await ble.init();

  const settings = await window.mvlp.invoke('config:getSettings');

  showView('dashboard');

  if (!settings.onboardingComplete) {
    renderOnboarding(document.getElementById('onboarding-root'), {
      onFinish: () => {
        document.getElementById('onboarding-root').hidden = true;
        showView('devices');
      },
    });
    document.getElementById('onboarding-root').hidden = false;
  }
}

bootstrap();
