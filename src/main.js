const { app, BrowserWindow, ipcMain, screen, globalShortcut, shell, Menu } = require('electron');
const path = require('path');
const { createCodexBridge, focusCodexDesktop } = require('./providers/create-bridge');
const codexSettings = require('./codex-settings');
const padPrefs = require('./pad-prefs');
const trial = require('./trial');
const i18n = require('./i18n');
const mac = require('./platform/mac');

let mainWindow = null;
let bridge = null;

function trialLocked() {
  return trial.isLocked();
}

function trialDenied() {
  return { ok: false, error: 'trial expired', trialExpired: true };
}
/** Global pad shortcuts armed while Codex CLI terminal is frontmost */
let cliPadGlobalsArmed = false;
let padContextTimer = null;

/** Base defs — modifier (Shift|Command) chosen in pad prefs */
const PAD_HOTKEY_DEFS = [
  { key: 'Q', cmd: 'fast' },
  { key: 'W', cmd: 'approve' },
  { key: 'E', cmd: 'decline' },
  { key: 'R', cmd: 'fork' },
  { key: 'D', cmd: 'mic', phase: 'toggle' },
  { key: 'F', cmd: 'send' },
  { key: 'Tab', cmd: 'touch' },
  { key: 'Up', cmd: 'joy', dir: 'up' },
  { key: 'Down', cmd: 'joy', dir: 'down' },
  { key: 'Left', cmd: 'joy', dir: 'left' },
  { key: 'Right', cmd: 'joy', dir: 'right' },
  { key: '1', cmd: 'agent', index: 0 },
  { key: '2', cmd: 'agent', index: 1 },
  { key: '3', cmd: 'agent', index: 2 },
  { key: '4', cmd: 'agent', index: 3 },
  { key: '5', cmd: 'agent', index: 4 },
  { key: '6', cmd: 'agent', index: 5 },
];

function buildPadGlobalHotkeys(mod = padPrefs.getHotkeyModifier()) {
  const prefix = padPrefs.acceleratorPrefix(mod);
  return PAD_HOTKEY_DEFS.map((d) => ({
    accelerator: `${prefix}+${d.key}`,
    cmd: d.cmd,
    phase: d.phase,
    dir: d.dir,
    index: d.index,
  }));
}

function allPadAccelerators() {
  const keys = PAD_HOTKEY_DEFS.map((d) => d.key);
  return keys.flatMap((k) => [`Shift+${k}`, `Command+${k}`]);
}

function sendHotkey(cmd, phase = 'tap', extra = {}) {
  if (trialLocked()) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) return;
  // Pad focused OR our CLI terminal context (globals armed)
  if (!mainWindow.isFocused() && !cliPadGlobalsArmed) return;
  mainWindow.webContents.send('hotkey', { cmd, phase, ...extra });
}

function unregisterCliPadGlobals() {
  for (const accelerator of allPadAccelerators()) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      /* ignore */
    }
  }
  cliPadGlobalsArmed = false;
}

function registerCliPadGlobals() {
  if (trialLocked()) {
    unregisterCliPadGlobals();
    return;
  }
  // Re-register every time we arm so failed keys get another chance
  let any = false;
  const list = buildPadGlobalHotkeys();
  for (const { accelerator, cmd, phase, dir, index } of list) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      /* ignore */
    }
    const extra = {};
    if (dir) extra.dir = dir;
    if (typeof index === 'number') extra.index = index;
    const ok = globalShortcut.register(accelerator, () =>
      sendHotkey(cmd, phase || 'tap', extra)
    );
    if (!ok) console.log('[hotkey] global failed', accelerator);
    else any = true;
  }
  cliPadGlobalsArmed = any;
}

function rearmPadHotkeys() {
  unregisterCliPadGlobals();
  syncPadHotkeyContext();
}

/**
 * Only two places capture pad shortcuts (and they win over OS/terminal):
 * 1) Agent Micro pad window focused
 * 2) Default terminal frontmost after this pad opened a Codex CLI there
 */
async function syncPadHotkeyContext() {
  try {
    if (trialLocked()) {
      unregisterCliPadGlobals();
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
      unregisterCliPadGlobals();
      return;
    }
    const padFocused = mainWindow.isFocused();
    const cliOurs = padFocused ? false : await mac.isOurCliFrontmost();
    if (padFocused || cliOurs) registerCliPadGlobals();
    else unregisterCliPadGlobals();
  } catch (e) {
    console.log('[hotkey] sync', e.message);
  }
}

function startPadContextWatch() {
  if (padContextTimer) return;
  padContextTimer = setInterval(() => {
    syncPadHotkeyContext();
  }, 350);
  syncPadHotkeyContext();
}

function stopPadContextWatch() {
  if (padContextTimer) {
    clearInterval(padContextTimer);
    padContextTimer = null;
  }
  unregisterCliPadGlobals();
}

/**
 * Pad focused → swallow non-pad shortcuts.
 * Chords use pad prefs modifier (⇧ or ⌘) + QWERDF / 1–6 / arrows / Tab.
 * When globals already armed, don't double-fire.
 */
function attachPadHotkeys(win) {
  win.__padHotkeysSuspended = false;
  win.webContents.on('before-input-event', (event, input) => {
    if (!input || input.type !== 'keyDown') return;
    if (!win.isFocused()) return;
    if (typeof app.isFocused === 'function' && !app.isFocused()) return;

    const key = String(input.key || '');
    const code = String(input.code || '');
    const meta = !!input.meta;
    const ctrl = !!input.control;
    const alt = !!input.alt;
    const shift = !!input.shift;
    const primary = process.platform === 'darwin' ? meta : ctrl;
    const mod = padPrefs.getHotkeyModifier();

    if (win.__padHotkeysSuspended) {
      // 입력 중: 대문자/기호 타이핑은 허용
      return;
    }

    // App chrome: ⌘⇧M / ⌘⇧Q
    if (primary && shift && !alt) {
      const k = key.toLowerCase();
      if (k === 'm' || k === 'q') return;
    }

    // Mod+Tab → Touch / layer
    const tabChord =
      mod === 'command'
        ? primary && !shift && !alt && (key === 'Tab' || code === 'Tab')
        : shift && !primary && !alt && !meta && !ctrl && (key === 'Tab' || code === 'Tab');
    if (tabChord) {
      event.preventDefault();
      if (!cliPadGlobalsArmed) sendHotkey('touch');
      return;
    }

    const hit = matchPadChord(mod, shift, primary, alt, meta, ctrl, key, code);
    if (hit) {
      event.preventDefault();
      if (cliPadGlobalsArmed) return;
      const extra = {};
      if (hit.dir) extra.dir = hit.dir;
      if (typeof hit.index === 'number') extra.index = hit.index;
      sendHotkey(hit.cmd, hit.phase || 'tap', extra);
      return;
    }

    // Pad focused: block other modifier shortcuts (keep bare Shift for typing when using ⌘)
    if (meta || ctrl || alt) event.preventDefault();
  });
}

/** Active modifier + QWERDF / arrows / 1–6 */
function matchPadChord(mod, shift, primary, alt, meta, ctrl, key, code) {
  if (alt) return null;
  if (mod === 'command') {
    if (!primary || shift) return null;
  } else {
    if (!shift || primary || meta || ctrl) return null;
  }

  const lower = key.length === 1 ? key.toLowerCase() : key;
  const cmdKeys = {
    q: { cmd: 'fast' },
    w: { cmd: 'approve' },
    e: { cmd: 'decline' },
    r: { cmd: 'fork' },
    d: { cmd: 'mic', phase: 'toggle' },
    f: { cmd: 'send' },
  };
  if (cmdKeys[lower]) return cmdKeys[lower];

  if (key === 'ArrowUp' || code === 'ArrowUp') return { cmd: 'joy', dir: 'up' };
  if (key === 'ArrowDown' || code === 'ArrowDown') return { cmd: 'joy', dir: 'down' };
  if (key === 'ArrowLeft' || code === 'ArrowLeft') return { cmd: 'joy', dir: 'left' };
  if (key === 'ArrowRight' || code === 'ArrowRight') return { cmd: 'joy', dir: 'right' };

  const digitMap = {
    Digit1: 0,
    Digit2: 1,
    Digit3: 2,
    Digit4: 3,
    Digit5: 4,
    Digit6: 5,
  };
  if (digitMap[code] != null) return { cmd: 'agent', index: digitMap[code] };
  if (/^[1-6]$/.test(key)) return { cmd: 'agent', index: Number(key) - 1 };
  // US layout Shift+1..6 → !@#$%^ (shift mode only)
  if (mod === 'shift') {
    const shifted = { '!': 0, '@': 1, '#': 2, $: 3, '%': 4, '^': 5 };
    if (shifted[key] != null) return { cmd: 'agent', index: shifted[key] };
  }

  return null;
}

function isPadChordKey(key, code) {
  const lower = String(key || '').toLowerCase();
  if (lower.length === 1 && 'qwerdf'.includes(lower)) return true;
  if (/^[1-6]$/.test(key)) return true;
  if (/^Digit[1-6]$/.test(code)) return true;
  if ('!@#$%^'.includes(key)) return true;
  if (/^Arrow(Up|Down|Left|Right)$/.test(key) || /^Arrow(Up|Down|Left|Right)$/.test(code)) {
    return true;
  }
  return false;
}

/** Quit stays ⌘⇧Q · Edit roles = paste/copy in inputs */
function installAppMenu() {
  const isMac = process.platform === 'darwin';
  const { t } = require('./i18n');
  const loc = padPrefs.getLocale();
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { label: t(loc, 'menu.about'), role: 'about' },
              { type: 'separator' },
              {
                label: t(loc, 'menu.quit'),
                accelerator: 'Command+Shift+Q',
                click: () => app.quit(),
              },
            ],
          },
        ]
      : []),
    {
      label: t(loc, 'menu.edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: t(loc, 'menu.window'),
      submenu: [
        {
          label: t(loc, 'menu.toggle'),
          accelerator: 'CommandOrControl+Shift+M',
          click: () => {
            if (!mainWindow) return;
            if (mainWindow.isVisible()) mainWindow.hide();
            else mainWindow.show();
          },
        },
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  // Fit chrome + pad (modest outer rim) + hud
  const winW = 344;
  const winH = 520;

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
    stopPadContextWatch();
  });

  for (const ev of ['focus', 'blur', 'show', 'hide']) {
    mainWindow.on(ev, () => syncPadHotkeyContext());
  }

  attachPadHotkeys(mainWindow);
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
  const userData = app.getPath('userData');
  codexSettings.setUserDataPath(userData);
  padPrefs.setUserDataPath(userData);
  trial.setUserDataPath(userData);

  installAppMenu();
  createWindow();

  const locked = trialLocked();
  if (!locked) {
    // Codex CLI (app-server) only
    bridge = createCodexBridge();
    bindBridge(bridge);
    setTimeout(() => bridge.start(), 400);
  }

  // ⌘⇧M always global. Pad keys: pad focused (local) OR Codex CLI terminal frontmost (global).
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
    syncPadHotkeyContext();
  });
  if (!locked) startPadContextWatch();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function ensureUnlockedRuntime() {
  if (trialLocked()) return false;
  if (!bridge) {
    bridge = createCodexBridge();
    bindBridge(bridge);
    setTimeout(() => bridge.start(), 200);
  }
  startPadContextWatch();
  syncPadHotkeyContext();
  return true;
}

app.on('window-all-closed', () => {
  bridge?.stop();
  stopPadContextWatch();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  bridge?.stop();
  stopPadContextWatch();
  globalShortcut.unregisterAll();
});

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:suspendPadHotkeys', (_e, suspended) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.__padHotkeysSuspended = !!suspended;
  }
  return true;
});

ipcMain.handle('trial:get', () => trial.getStatus());
ipcMain.handle('trial:openSponsor', () => {
  const url = trial.getSponsorUrl();
  if (!url) return { ok: false, error: 'no sponsor url' };
  shell.openExternal(url);
  return { ok: true };
});
ipcMain.handle('trial:activate', (_e, key) => {
  const r = trial.activateLicense(key);
  if (!r?.ok) return r;
  ensureUnlockedRuntime();
  return { ...r, trial: trial.getStatus() };
});

ipcMain.handle('codexSettings:get', () => {
  if (trialLocked()) return { settings: null, meta: null, trialExpired: true };
  return {
    settings: codexSettings.load(),
    meta: codexSettings.meta(),
  };
});
ipcMain.handle('codexSettings:save', (_e, partial) => {
  if (trialLocked()) return trialDenied();
  return codexSettings.save(partial || {});
});
ipcMain.handle('codexSettings:writeIgnore', async () => {
  if (trialLocked()) return trialDenied();
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(mainWindow, {
    title: require('./i18n').t(padPrefs.getLocale(), 'settings.dialog.ignore'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths?.[0]) return { ok: false, canceled: true };
  return codexSettings.writeCodexIgnore(r.filePaths[0]);
});
ipcMain.handle('codexSettings:openConfig', () => {
  if (trialLocked()) return trialDenied();
  const p = codexSettings.meta().configPath;
  return shell.openPath(p);
});
/** Sync i18n for sandboxed preload (cannot require ./i18n there) */
ipcMain.on('i18n:t', (event, payload = {}) => {
  event.returnValue = i18n.t(payload.locale, payload.key, payload.vars || {});
});
ipcMain.on('i18n:normalizeLocale', (event, locale) => {
  event.returnValue = i18n.normalizeLocale(locale);
});

ipcMain.handle('padPrefs:get', () => padPrefs.load());
ipcMain.handle('padPrefs:set', (_e, partial) => {
  if (trialLocked()) return trialDenied();
  const next = padPrefs.save(partial || {});
  rearmPadHotkeys();
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'locale')) {
    installAppMenu();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('padPrefs:changed', next);
  }
  return next;
});
ipcMain.handle('voice:beginDictation', async () => {
  if (trialLocked()) return trialDenied();
  if (!bridge?.beginVoiceDictation) {
    return { ok: false, error: 'dictation not supported' };
  }
  // Dictation lands in the pad's hidden text sink — keep pad key-focused
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setFocusable(true);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  } catch {
    /* ignore */
  }
  return bridge.beginVoiceDictation();
});
ipcMain.handle('voice:endDictation', async () => {
  if (trialLocked()) return trialDenied();
  return (await bridge?.endVoiceDictation?.()) || { ok: false };
});
ipcMain.handle('voice:submitText', async (_e, text) => {
  if (trialLocked()) return trialDenied();
  let r = { ok: false };
  try {
    r = (await bridge?.submitVoiceText?.(text)) || { ok: false };
  } finally {
    refocusPad(380);
  }
  return r;
});

ipcMain.handle('codex:getState', () => {
  if (trialLocked()) return null;
  return bridge?.getState();
});
ipcMain.handle('codex:select', async (_e, index, focus) => {
  if (trialLocked()) return trialDenied();
  // Opens Codex CLI window/split — then arm globals if terminal takes focus
  const r = await bridge?.select(index, { focus });
  setTimeout(() => syncPadHotkeyContext(), 400);
  return r;
});
async function withCliFocus(run) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFocusable(false);
  } catch {
    /* ignore */
  }
  try {
    return await run();
  } finally {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFocusable(true);
    } catch {
      /* ignore */
    }
    refocusPad(450);
  }
}

ipcMain.handle('codex:approve', async () => {
  if (trialLocked()) return trialDenied();
  return withCliFocus(() => bridge?.approve());
});
ipcMain.handle('codex:decline', async () => {
  if (trialLocked()) return trialDenied();
  return withCliFocus(() => bridge?.decline());
});
ipcMain.handle('codex:fork', async () => {
  if (trialLocked()) return trialDenied();
  return withCliFocus(() => bridge?.fork());
});
ipcMain.handle('codex:send', async (_e, text) => {
  if (trialLocked()) return trialDenied();
  return withCliFocus(() => bridge?.send(text));
});
ipcMain.handle('codex:setReasoning', (_e, index) => {
  if (trialLocked()) return trialDenied();
  return bridge?.setReasoning(index);
});
ipcMain.handle('codex:toggleFast', () => {
  if (trialLocked()) return trialDenied();
  return bridge?.toggleFast();
});
ipcMain.handle('codex:togglePlan', () => {
  if (trialLocked()) return trialDenied();
  return bridge?.togglePlan();
});
ipcMain.handle('codex:skill', async (_e, name) => {
  if (trialLocked()) return trialDenied();
  // skill → send() into CLI; must steal pad focus like Send
  return withCliFocus(() => bridge?.skill(name));
});
ipcMain.handle('codex:newChat', async () => {
  if (trialLocked()) return trialDenied();
  return withCliFocus(() => bridge?.newChat());
});
ipcMain.handle('codex:desktop', async (_e, action) => {
  if (trialLocked()) return trialDenied();
  // Legacy name — maps to CLI agent/nav helpers in the bridge
  return bridge?.desktopAction(action);
});
ipcMain.handle('codex:voice', async (_e, text) => {
  if (trialLocked()) return trialDenied();
  if (!bridge?.voiceToCodex) {
    await bridge?.send?.(text);
    return { ok: true, mode: 'send-only' };
  }
  return bridge.voiceToCodex(text);
});
ipcMain.handle('codex:focusApp', () => {
  if (trialLocked()) return false;
  focusCodexDesktop();
  bridge?.focusApp?.();
  refocusPad(320);
  return true;
});
ipcMain.handle('codex:linkInfo', () => {
  if (trialLocked()) return { connected: false, trialExpired: true };
  return bridge?.getLinkInfo();
});
ipcMain.handle('codex:loginStatus', () => {
  if (trialLocked()) return { ok: false, trialExpired: true };
  return bridge?.checkLogin();
});
ipcMain.handle('codex:login', () => {
  if (trialLocked()) return trialDenied();
  return bridge?.login();
});
ipcMain.handle('codex:connect', async (_e, opts) => {
  if (trialLocked()) return trialDenied();
  ensureBridge({ autoStart: false });
  const result = await bridge.connect(opts || {});
  return { ...(result && typeof result === 'object' ? result : { ok: !!result }), linkMode: 'cli' };
});
ipcMain.handle('codex:reconnect', async () => {
  if (trialLocked()) return trialDenied();
  ensureBridge({ autoStart: false });
  const info = bridge.getLinkInfo?.() || {};
  let result;
  if (!info.connected) result = await bridge.connect();
  else {
    bridge.stop();
    const started = await bridge.start();
    result = { ok: !!started, reason: started ? 'connected' : 'offline', linkMode: 'cli' };
  }
  return { ...(result && typeof result === 'object' ? result : { ok: !!result }), linkMode: 'cli' };
});
