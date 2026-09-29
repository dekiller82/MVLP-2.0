'use strict';

const root = document.getElementById('modal-root');
let currentClose = null;

export function openModal(contentEl, { onClose } = {}) {
  closeModal();
  root.innerHTML = '';
  root.appendChild(contentEl);
  root.hidden = false;

  const close = (opts = {}) => {
    root.hidden = true;
    root.innerHTML = '';
    currentClose = null;
    if (onClose && !opts.silent) onClose();
  };
  currentClose = close;

  root.onclick = (e) => {
    if (e.target === root) close();
  };

  return { close };
}

export function closeModal() {
  if (currentClose) currentClose();
}

export function confirmModal({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'modal';
    el.innerHTML = `
      <h2>${title}</h2>
      <p style="color:var(--text-dim);font-size:13px;margin:0;">${message}</p>
      <div class="modal-actions">
        <button class="btn" data-action="cancel">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="confirm">${confirmLabel}</button>
      </div>
    `;
    const { close } = openModal(el, { onClose: () => resolve(false) });
    el.querySelector('[data-action="cancel"]').onclick = () => close();
    el.querySelector('[data-action="confirm"]').onclick = () => {
      resolve(true);
      currentClose = null; // avoid double-resolve via onClose
      root.hidden = true;
      root.innerHTML = '';
    };
  });
}
