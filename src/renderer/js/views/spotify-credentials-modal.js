'use strict';

import { openModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';

const REDIRECT_URI = 'http://127.0.0.1:8888/callback';

export function openSpotifyCredentialsModal({ clientId = '', onSaved } = {}) {
  const el = document.createElement('div');
  el.className = 'modal';
  el.style.maxWidth = '480px';
  el.innerHTML = `
    <h2>Connect Spotify</h2>
    <p class="help-text">Spotify requires your own free developer app to read what's currently playing.</p>
    <div class="card" style="background:var(--surface-2);gap:8px;padding:14px;">
      <p style="margin:0;font-size:12.5px;line-height:1.6;">
        1. Open the <a href="#" id="sp-dev-link">Spotify Developer Dashboard</a> and click <strong>Create App</strong>.<br/>
        2. Copy the <strong>Client ID</strong> and <strong>Client Secret</strong> into the fields below.<br/>
        3. In the app's <strong>Redirect URIs</strong>, add the URL below, then Save.
      </p>
      <div class="field-row">
        <input type="text" value="${REDIRECT_URI}" readonly />
        <button class="btn btn-sm" id="sp-copy-uri" type="button">Copy</button>
      </div>
    </div>
    <div class="field">
      <label>Client ID</label>
      <input type="text" id="sp-client-id" placeholder="e.g. 8f3c1a9b2d4e..." />
    </div>
    <div class="field">
      <label>Client Secret</label>
      <input type="password" id="sp-client-secret" placeholder="••••••••••••" />
    </div>
    <div class="modal-actions">
      <button class="btn" data-action="cancel" type="button">Cancel</button>
      <button class="btn btn-primary" data-action="save" type="button">Save &amp; Connect</button>
    </div>
  `;

  const idInput = el.querySelector('#sp-client-id');
  idInput.value = clientId || '';

  const { close } = openModal(el);

  el.querySelector('#sp-dev-link').onclick = (e) => {
    e.preventDefault();
    window.mvlp.invoke('app:openExternal', 'https://developer.spotify.com/dashboard');
  };
  el.querySelector('#sp-copy-uri').onclick = () => {
    navigator.clipboard.writeText(REDIRECT_URI);
    showToast('Redirect URI copied to clipboard.', 'success', 2000);
  };
  el.querySelector('[data-action="cancel"]').onclick = () => close();
  el.querySelector('[data-action="save"]').onclick = async () => {
    const id = idInput.value.trim();
    const secret = el.querySelector('#sp-client-secret').value.trim();
    if (!id || !secret) {
      showToast('Both Client ID and Client Secret are required.', 'error');
      return;
    }
    close();
    await window.mvlp.invoke('spotify:saveAndConnect', id, secret);
    if (onSaved) onSaved();
  };
}
