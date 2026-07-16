const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const { CodexBridge, focusChatGPT } = require('./codex-bridge');

let mainWindow = null;
let bridge = null;

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const winW = 460;
  const winH = 580;

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: Math.round(sw - winW - 40),
    y: Math.round(sh - winH - 40),
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    titleBarStyle: 'customButtonsOnHover',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents
      .executeJavaScript(
        `!!document.querySelector('#pad-canvas canvas') ? 'ok' : 'no-canvas'`
      )
      .then((r) => console.log('[pad]', r))
      .catch((e) => console.error('[pad]', e));
  });
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[renderer]', message);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function pushState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('codex:state', state);
  }
}

app.whenReady().then(async () => {
  createWindow();

  bridge = new CodexBridge();
  bridge.on('state', (s) => pushState(s));
  bridge.on('log', (m) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('codex:log', m);
    }
  });

  // Start after UI loads a beat
  setTimeout(() => bridge.start(), 400);

  globalShortcut.register('CommandOrControl+Shift+M', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  bridge?.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  bridge?.stop();
  globalShortcut.unregisterAll();
});

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:close', () => mainWindow?.close());

ipcMain.handle('codex:getState', () => bridge?.getState());
ipcMain.handle('codex:select', (_e, index, focus) => bridge?.select(index, { focus }));
ipcMain.handle('codex:approve', () => bridge?.approve());
ipcMain.handle('codex:decline', () => bridge?.decline());
ipcMain.handle('codex:fork', () => bridge?.fork());
ipcMain.handle('codex:send', (_e, text) => bridge?.send(text));
ipcMain.handle('codex:setReasoning', (_e, index) => bridge?.setReasoning(index));
ipcMain.handle('codex:toggleFast', () => bridge?.toggleFast());
ipcMain.handle('codex:togglePlan', () => bridge?.togglePlan());
ipcMain.handle('codex:focusApp', () => {
  focusChatGPT();
  return true;
});
ipcMain.handle('codex:reconnect', async () => {
  bridge?.stop();
  bridge = new CodexBridge();
  bridge.on('state', (s) => pushState(s));
  return bridge.start();
});
