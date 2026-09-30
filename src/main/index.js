'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');

const logger = require('./logger');
const store = require('./store');
const { BleBridge } = require('./ble-bridge');
const { AppController } = require('./controller');
const { AppTray } = require('./tray');
const { registerIpc } = require('./ipc');
const autolaunch = require('./autolaunch');
const { Updater } = require('./updater');

if (process.platform === 'win32') {
  app.setAppUserModelId('app.mvlp.desktop');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow;
let tray;
let controller;
let bleBridge;
let updater;
let shuttingDown = false;

function createWindow() {
  const settings = store.getSettings();

  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    show: !(settings.launchAtLogin && settings.startMinimized && autolaunch.wasLaunchedAtLogin()), // "start in tray" applies to login starts only
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      logger.info('Renderer', `${message} (${sourceId}:${line})`);
    });
  }

  mainWindow.on('close', (event) => {
    const s = store.getSettings();
    if (!shuttingDown && s.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // If the renderer dies, reload the window so the user just sees the UI
  // reset instead of the app vanishing (BLE links live in main and survive).
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('App', `Renderer process gone (reason: ${details.reason}). Reloading window.`);
    if (!shuttingDown && !mainWindow.isDestroyed()) mainWindow.reload();
  });

  return mainWindow;
}

app.whenReady().then(() => {
  createWindow();

  bleBridge = new BleBridge(mainWindow);
  controller = new AppController(bleBridge);
  tray = new AppTray(mainWindow);

  // In-app installs work for the Windows installer and the Linux AppImage; see updater.js. Elsewhere the button opens the release page.
  const canInstall = app.isPackaged && (process.platform === 'win32' || (process.platform === 'linux' && Boolean(process.env.APPIMAGE)));
  updater = new Updater({ currentVersion: app.getVersion(), canInstall, getAutoUpdater: () => require('electron-updater').autoUpdater });
  updater.on('state', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updater:state', state);
  });

  registerIpc({ mainWindow, bleBridge, controller, updater });

  // The tray menu's ticks follow the real state, whoever changed it (the tray, the dashboard or startup).
  const refreshTrayMenu = () => tray.updateMenu({
    mvEnabled: controller.mvEnabled,
    spotifyEnabled: controller.spotifyEnabled,
    onToggleMv: (on) => controller.setMultiviewerEnabled(on),
    onToggleSpotify: (on) => {
      const creds = store.getSpotifyCredentials();
      if (on && !(creds.clientId && creds.clientSecret)) {
        // Spotify needs its credentials first: the dashboard has the form.
        mainWindow.show();
        mainWindow.focus();
        refreshTrayMenu();
        return;
      }
      controller.setSpotifyEnabled(on, creds.clientId, creds.clientSecret).catch(() => {});
    },
  });
  controller.on('integrations', refreshTrayMenu);
  refreshTrayMenu();

  controller.on('mv:status', (state) => tray.setStatus(state === 'connected' ? 'connected' : state === 'retrying' ? 'warning' : 'idle'));

  const settings = store.getSettings();
  if (settings.mvEnabled) controller.setMultiviewerEnabled(true);
  if (settings.spotifyEnabled) {
    const creds = store.getSpotifyCredentials();
    if (creds.clientId && creds.clientSecret) controller.setSpotifyEnabled(true, creds.clientId, creds.clientSecret);
  }
  autolaunch.setLaunchAtLogin(Boolean(settings.launchAtLogin));
  if (app.isPackaged) updater.startAutoCheck(settings.autoUpdateCheck !== false);

  logger.info('App', 'MVLP started.');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  Promise.resolve(controller?.shutdown())
    .catch(() => {})
    .then(() => bleBridge?.shutdown())
    .catch(() => {})
    .finally(() => {
      tray?.destroy();
      app.quit();
    });
});
