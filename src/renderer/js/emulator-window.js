'use strict';

import { mountEmulator } from './components/emulator.js';

const id = new URLSearchParams(window.location.search).get('id');

async function start() {
  const config = await window.mvlp.invoke('emulator:getConfig', id);
  document.title = config.name;
  const emulator = mountEmulator(document.getElementById('emulator-root'), id, config);
  window.mvlp.on('emulator:config', (next) => {
    if (next.id !== id) return;
    document.title = next.name;
    emulator.configure(next);
  });
  window.addEventListener('unload', () => emulator.dispose());
}

start();
