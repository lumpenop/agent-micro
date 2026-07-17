const { app, BrowserWindow, ipcMain, screen, globalShortcut, session, systemPreferences, shell } = require('electron');
const path = require('path');
const { createCodexBridge, focusCodexDesktop } = require('./providers/create-bridge');
const {
  setUserDataPath: setVoiceUserDataPath,
  transcribeWithWhisper,
  hasWhisperAuth,
  writeStoredApiKey,
  voiceStatus,
  needsVoiceSetup,
  markVoiceSetupDone,
} = require('./voice-transcribe');

let mainWindow = null;
let bridge = null;

async function ensureMicAccess() {
  if (process.platform !== 'darwin') return true;
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return true;
    const ok = await systemPreferences.askForMediaAccess('microphone');
    return !!ok;
  } catch {
    return false;
  }
}

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
    ensureMicAccess().then((ok) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mic:status', { granted: ok });
      }
    });
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

/** After Codex steals focus, bring the pad back so it keeps taking input. */
function refocusPad(delayMs = 280) {
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setAlwaysOnTop(true, 'floating');
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      if (typeof app.focus === 'function') app.focus({ steal: true });
    } catch (e) {
      console.log('[refocus]', e.message);
    }
  }, delayMs);
}

function bindBridge(b) {
  b.on('state', (s) => pushState(s));
  b.on('log', (m) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('codex:log', m);
    }
  });
}

function ensureBridge({ autoStart = true } = {}) {
  if (bridge) return bridge;
  bridge = createCodexBridge();
  bindBridge(bridge);
  if (autoStart) setTimeout(() => bridge.start(), 200);
  return bridge;
}

app.whenReady().then(async () => {
  setVoiceUserDataPath(app.getPath('userData'));

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') callback(true);
    else callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media' || permission === 'microphone';
  });

  ensureMicAccess();
  createWindow();

  // Codex CLI (app-server) only
  bridge = createCodexBridge();
  bindBridge(bridge);
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
ipcMain.handle('mic:request', () => ensureMicAccess());
ipcMain.handle('mic:status', () => {
  if (process.platform !== 'darwin') return { granted: true, status: 'granted' };
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    return { granted: status === 'granted', status, whisper: hasWhisperAuth() };
  } catch {
    return { granted: false, status: 'unknown', whisper: hasWhisperAuth() };
  }
});
ipcMain.handle('mic:transcribe', async (_e, payload) => {
  const { base64, mimeType } = payload || {};
  if (!base64) return { ok: false, error: 'empty audio' };
  try {
    const bytes = Buffer.from(base64, 'base64');
    const result = await transcribeWithWhisper(bytes, mimeType || 'audio/webm');
    return { ok: true, text: result.text };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || 'TRANSCRIBE' };
  }
});
ipcMain.handle('mic:whisperReady', () => ({ ok: hasWhisperAuth() }));
ipcMain.handle('voice:status', () => voiceStatus());
ipcMain.handle('voice:setApiKey', (_e, key) => {
  try {
    const r = writeStoredApiKey(key);
    return { ...r, ...voiceStatus() };
  } catch (e) {
    return { ok: false, error: e.message, ...voiceStatus() };
  }
});
ipcMain.handle('voice:skipSetup', () => markVoiceSetupDone({ skipped: true }));
ipcMain.handle('voice:openApiKeysPage', () => {
  shell.openExternal('https://platform.openai.com/api-keys');
  return true;
});
ipcMain.handle('voice:beginDictation', async () => {
  if (!bridge?.beginVoiceDictation) {
    return { ok: false, error: 'dictation not supported' };
  }
  return bridge.beginVoiceDictation();
});
ipcMain.handle('voice:endDictation', async () => {
  const r = (await bridge?.endVoiceDictation?.()) || { ok: false };
  refocusPad(280);
  return r;
});

ipcMain.handle('codex:getState', () => bridge?.getState());
ipcMain.handle('codex:select', async (_e, index, focus) => {
  const r = await bridge?.select(index, { focus });
  if (focus) refocusPad(320);
  return r;
});
ipcMain.handle('codex:approve', () => bridge?.approve());
ipcMain.handle('codex:decline', () => bridge?.decline());
ipcMain.handle('codex:fork', () => bridge?.fork());
ipcMain.handle('codex:send', (_e, text) => bridge?.send(text));
ipcMain.handle('codex:setReasoning', (_e, index) => bridge?.setReasoning(index));
ipcMain.handle('codex:toggleFast', () => bridge?.toggleFast());
ipcMain.handle('codex:togglePlan', () => bridge?.togglePlan());
ipcMain.handle('codex:skill', (_e, name) => bridge?.skill(name));
ipcMain.handle('codex:newChat', () => bridge?.newChat());
ipcMain.handle('codex:desktop', async (_e, action) => {
  // Legacy name — maps to CLI agent/nav helpers in the bridge
  return bridge?.desktopAction(action);
});
ipcMain.handle('codex:voice', async (_e, text) => {
  if (!bridge?.voiceToCodex) {
    await bridge?.send?.(text);
    return { ok: true, mode: 'send-only' };
  }
  return bridge.voiceToCodex(text);
});
ipcMain.handle('codex:focusApp', () => {
  focusCodexDesktop();
  bridge?.focusApp?.();
  refocusPad(320);
  return true;
});
ipcMain.handle('codex:linkInfo', () => bridge?.getLinkInfo());
ipcMain.handle('codex:loginStatus', () => bridge?.checkLogin());
ipcMain.handle('codex:login', () => bridge?.login());
function withVoiceSetup(result) {
  const base = result && typeof result === 'object' ? result : { ok: !!result };
  const needsSetup = !!(base.ok && needsVoiceSetup());
  return {
    ...base,
    linkMode: 'cli',
    needsVoiceSetup: needsSetup,
    needsApiKey: needsSetup,
    voice: voiceStatus(),
  };
}

ipcMain.handle('codex:connect', async (_e, opts) => {
  ensureBridge({ autoStart: false });
  const result = await bridge.connect(opts || {});
  return withVoiceSetup(result);
});
ipcMain.handle('codex:reconnect', async () => {
  ensureBridge({ autoStart: false });
  const info = bridge.getLinkInfo?.() || {};
  let result;
  if (!info.connected) result = await bridge.connect();
  else {
    bridge.stop();
    const started = await bridge.start();
    result = { ok: !!started, reason: started ? 'connected' : 'offline', linkMode: 'cli' };
  }
  return withVoiceSetup(result);
});
