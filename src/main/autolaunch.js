'use strict';

const { app } = require('electron');

function setLaunchAtLogin(enabled) {
  if (process.platform === 'linux') {
    // Electron's setLoginItemSettings has spotty Linux support across desktop
    // environments; skip silently rather than pretend it worked.
    return false;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
  return true;
}

function getLaunchAtLogin() {
  return app.getLoginItemSettings().openAtLogin;
}

module.exports = { setLaunchAtLogin, getLaunchAtLogin };
