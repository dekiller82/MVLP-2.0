'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

/**
 * Launch at login.
 *  - Windows and macOS: Electron's login item. Windows gets `--hidden` as an argument, so a login
 *    start can be told apart from a normal one (macOS reports it directly).
 *  - Linux: an XDG autostart entry (~/.config/autostart), which GNOME, KDE, Xfce and most others honour.
 *
 * Nothing is registered while running from source: it would point the login item at the Electron binary.
 */

const HIDDEN_FLAG = '--hidden';
const AUTOSTART_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'mvlp.desktop');

function desktopEntry() {
  const exec = process.env.APPIMAGE || process.execPath; // an AppImage moves around; its own path is the stable one
  return `[Desktop Entry]\nType=Application\nName=MVLP\nComment=Shows F1 status and Spotify art on an LED panel\nExec="${exec}" ${HIDDEN_FLAG}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
}

function setLaunchAtLogin(enabled) {
  if (!app.isPackaged) return false;
  if (process.platform === 'linux') {
    try {
      if (enabled) {
        fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
        fs.writeFileSync(AUTOSTART_FILE, desktopEntry());
      } else {
        fs.rmSync(AUTOSTART_FILE, { force: true });
      }
      return true;
    } catch {
      return false;
    }
  }
  app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_FLAG] });
  return true;
}

function getLaunchAtLogin() {
  if (process.platform === 'linux') return fs.existsSync(AUTOSTART_FILE);
  return app.getLoginItemSettings({ args: [HIDDEN_FLAG] }).openAtLogin;
}

/** True if this run was started by the login item rather than by the user. */
function wasLaunchedAtLogin() {
  if (process.argv.includes(HIDDEN_FLAG)) return true;
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
}

module.exports = { setLaunchAtLogin, getLaunchAtLogin, wasLaunchedAtLogin };
