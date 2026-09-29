'use strict';

const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');

const ICONS_DIR = path.join(__dirname, '..', '..', 'assets', 'icons');

function iconFor(state) {
  const name = { connected: 'tray-green-32.png', warning: 'tray-yellow-32.png', error: 'tray-red-32.png' }[state] || 'tray-idle-32.png';
  return nativeImage.createFromPath(path.join(ICONS_DIR, name));
}

class AppTray {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.tray = new Tray(iconFor('idle'));
    this.tray.setToolTip('MVLP');
    this._buildMenu({});
    this.tray.on('click', () => this._toggleWindow());
  }

  _toggleWindow() {
    if (this.mainWindow.isVisible()) this.mainWindow.hide();
    else {
      this.mainWindow.show();
      this.mainWindow.focus();
    }
  }

  setStatus(state, statusText) {
    this.tray.setImage(iconFor(state));
    this.tray.setToolTip(statusText ? `MVLP — ${statusText}` : 'MVLP');
  }

  _buildMenu({ mvEnabled, spotifyEnabled, onToggleMv, onToggleSpotify }) {
    const menu = Menu.buildFromTemplate([
      { label: 'Show MVLP', click: () => { this.mainWindow.show(); this.mainWindow.focus(); } },
      { type: 'separator' },
      {
        label: 'Multiviewer Integration',
        type: 'checkbox',
        checked: Boolean(mvEnabled),
        click: (item) => onToggleMv && onToggleMv(item.checked),
      },
      {
        label: 'Spotify Integration',
        type: 'checkbox',
        checked: Boolean(spotifyEnabled),
        click: (item) => onToggleSpotify && onToggleSpotify(item.checked),
      },
      { type: 'separator' },
      { label: 'Quit MVLP', click: () => app.quit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  updateMenu(state) {
    this._buildMenu(state);
  }

  destroy() {
    this.tray.destroy();
  }
}

module.exports = { AppTray };
