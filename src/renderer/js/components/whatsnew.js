'use strict';

import { openModal } from './modal.js';
import { escapeHtml } from '../util.js';

/** The What's new window: one block per version, each with its sections and bullets. */
export function showWhatsNew(entries, { title = "What's new" } = {}) {
  if (!entries.length) return;
  const el = document.createElement('div');
  el.className = 'modal whatsnew';
  el.innerHTML = `
    <h2>${escapeHtml(title)}</h2>
    <div class="whatsnew-body">
      ${entries.map((e) => `
        <section>
          <h3>Version ${escapeHtml(e.version)}${e.date ? ` <span>${escapeHtml(e.date)}</span>` : ''}</h3>
          ${e.intro ? `<p>${escapeHtml(e.intro)}</p>` : ''}
          ${e.sections.map((s) => `
            <h4>${escapeHtml(s.title)}</h4>
            <ul>${s.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`).join('')}
        </section>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn" data-action="release">Release page</button>
      <button class="btn btn-primary" data-action="close">Close</button>
    </div>`;
  const { close } = openModal(el);
  el.querySelector('[data-action="close"]').onclick = () => close();
  el.querySelector('[data-action="release"]').onclick = () => window.mvlp.invoke('updater:openRelease');
}
