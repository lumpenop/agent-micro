const { app, BrowserWindow, ipcMain, screen, globalShortcut, shell, Menu, dialog, net } = require('electron');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const path = require('path');
const { createCodexBridge, focusCodexDesktop } = require('./providers/create-bridge');
const codexSettings = require('./codex-settings');
const padPrefs = require('./pad-prefs');
const trial = require('./trial');
const i18n = require('./i18n');
const mac = require('./platform/mac');
const skillManager = require('./skill-manager');
const { detectDevCommand } = require('./dev-runner');

let mainWindow = null;
let bridge = null;
const devServers = new Map();

function selectedWorkspace() {
  const agent = bridge?.agents?.[bridge?.selected || 0];
  const candidate = agent?.projectRoot || agent?.cwd || codexSettings.load()?.working_directory || process.cwd();
  const resolved = path.resolve(String(candidate || process.cwd()));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('Selected agent working folder is unavailable');
  return resolved;
}

function stopDevServer(cwd) {
  const child = devServers.get(cwd);
  if (!child) return false;
  devServers.delete(cwd);
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  return true;
}

function trialLocked() {
  return trial.isLocked();
}

function trialDenied() {
  return { ok: false, error: 'trial expired', trialExpired: true };
}
/** Global pad shortcuts armed while Codex CLI terminal is frontmost */
let cliPadGlobalsArmed = false;
let padContextTimer = null;

/** Base defs — modifier (⌘ ⌥ ⌃ ⇪) chosen in pad prefs */
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

/** Caps Lock LED/lock state — used when modifier is capslock */
let capsLockOn = false;

function buildPadGlobalHotkeys(mod = padPrefs.getHotkeyModifier()) {
  const prefix = padPrefs.acceleratorPrefix(mod);
  return PAD_HOTKEY_DEFS.map((d) => ({
    accelerator: prefix ? `${prefix}+${d.key}` : d.key,
    cmd: d.cmd,
    phase: d.phase,
    dir: d.dir,
    index: d.index,
    requiresCaps: mod === 'capslock',
  }));
}

function allPadAccelerators() {
  const keys = PAD_HOTKEY_DEFS.map((d) => d.key);
  const mods = ['Command', 'Option', 'Control', ''];
  return keys.flatMap((k) => mods.map((m) => (m ? `${m}+${k}` : k)));
}

function readCapsLockOnMac() {
  if (process.platform !== 'darwin') return null;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        'ObjC.import("Cocoa"); (!!($.NSEvent.modifierFlags & $.NSEventModifierFlagCapsLock)) ? "1" : "0"',
      ],
      { timeout: 400, encoding: 'utf8' }
    ).trim();
    return out === '1';
  } catch {
    return null;
  }
}

function refreshCapsLockState() {
  const live = readCapsLockOnMac();
  if (live != null) capsLockOn = live;
  return capsLockOn;
}

/** Dedupe pad+global double-delivery */
let lastHotkeySig = '';
let lastHotkeyAt = 0;

function sendHotkey(cmd, phase = 'tap', extra = {}) {
  if (trialLocked()) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) return;
  // Pad focused OR our CLI terminal context (globals armed)
  if (!mainWindow.isFocused() && !cliPadGlobalsArmed) return;

  const sig = `${cmd}|${phase}|${extra.dir || ''}|${extra.index ?? ''}`;
  const now = Date.now();
  if (sig === lastHotkeySig && now - lastHotkeyAt < 90) return;
  lastHotkeySig = sig;
  lastHotkeyAt = now;

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

/**
 * Steal pad chords at the OS level while our Codex CLI is frontmost.
 * (Pad-focused input uses before-input instead — higher priority inside the app.)
 */
function registerCliPadGlobals() {
  if (trialLocked()) {
    unregisterCliPadGlobals();
    return;
  }
  const mod = padPrefs.getHotkeyModifier();
  if (mod === 'capslock') refreshCapsLockState();

  // Clear every known accelerator first so we always own the binding
  unregisterCliPadGlobals();

  let any = false;
  const failed = [];
  const list = buildPadGlobalHotkeys(mod);
  for (const { accelerator, cmd, phase, dir, index, requiresCaps } of list) {
    // Caps Lock layer: only steal bare keys while Caps Lock is on
    if (requiresCaps && !capsLockOn) continue;

    const extra = {};
    if (dir) extra.dir = dir;
    if (typeof index === 'number') extra.index = index;
    const ok = globalShortcut.register(accelerator, () => {
      if (requiresCaps) {
        refreshCapsLockState();
        if (!capsLockOn) return;
      }
      sendHotkey(cmd, phase || 'tap', extra);
    });
    if (!ok) {
      failed.push(accelerator);
      console.log('[hotkey] global failed (OS/other app owns it)', accelerator);
    } else {
      any = true;
    }
  }
  if (failed.length) {
    console.log('[hotkey] could not claim', failed.length, 'accelerators:', failed.join(', '));
  }
  cliPadGlobalsArmed = any;
}

function rearmPadHotkeys() {
  unregisterCliPadGlobals();
  syncPadHotkeyContext();
}

/**
 * Priority model (highest → lowest for pad chords):
 * 1) Pad window focused → before-input-event (beats menus / page / inputs)
 * 2) Our Codex CLI frontmost → globalShortcut (beats terminal keybindings)
 * 3) Elsewhere → unregistered (OS / other apps keep their shortcuts)
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
    if (padPrefs.getHotkeyModifier() === 'capslock') {
      const prev = capsLockOn;
      refreshCapsLockState();
      if (prev !== capsLockOn && cliPadGlobalsArmed) {
        unregisterCliPadGlobals();
      }
    }
    const padFocused = mainWindow.isFocused();
    if (padFocused) {
      // Local before-input owns chords — do not also arm globals (avoids races)
      unregisterCliPadGlobals();
      return;
    }
    const cliOurs = await mac.isOurCliFrontmost();
    if (cliOurs) registerCliPadGlobals();
    else unregisterCliPadGlobals();
  } catch (e) {
    console.log('[hotkey] sync', e.message);
  }
}

function startPadContextWatch() {
  if (padContextTimer) return;
  // Tight loop so CLI focus steals chords quickly after leaving the pad
  padContextTimer = setInterval(() => {
    syncPadHotkeyContext();
  }, 200);
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
 * Pad focused → pad Mod chords always win (menus, inputs, page shortcuts).
 * Suspend only allows bare typing / system edit keys; Mod chords stay first.
 */
function attachPadHotkeys(win) {
  win.__padHotkeysSuspended = false;
  win.webContents.on('before-input-event', (event, input) => {
    if (!input || (input.type !== 'keyDown' && input.type !== 'keyUp')) return;
    if (!win.isFocused()) return;
    if (typeof app.isFocused === 'function' && !app.isFocused()) return;

    const key = String(input.key || '');
    const code = String(input.code || '');

    // Keep Caps Lock lock state in sync (toggle key)
    if (key === 'CapsLock' || code === 'CapsLock') {
      if (input.type === 'keyDown') {
        const live = readCapsLockOnMac();
        capsLockOn = live != null ? live : !capsLockOn;
        if (padPrefs.getHotkeyModifier() === 'capslock') rearmPadHotkeys();
      }
      return;
    }

    if (input.type !== 'keyDown') return;

    const meta = !!input.meta;
    const ctrl = !!input.control;
    const alt = !!input.alt;
    const shift = !!input.shift;
    const primary = process.platform === 'darwin' ? meta : ctrl;
    const mod = padPrefs.getHotkeyModifier();
    const flags = { shift, primary, alt, meta, ctrl };

    // App chrome: ⌘⇧M / ⌘⇧Q (not pad chords)
    if (primary && shift && !alt) {
      const k = key.toLowerCase();
      if (k === 'm' || k === 'q') return;
    }

    // ── Pad Mod chords: highest priority (even while an input is focused) ──
    if (isModChord(mod, flags) && (key === 'Tab' || code === 'Tab')) {
      event.preventDefault();
      sendHotkey('touch');
      return;
    }

    const hit = matchPadChord(mod, flags, key, code);
    if (hit) {
      event.preventDefault();
      const extra = {};
      if (hit.dir) extra.dir = hit.dir;
      if (typeof hit.index === 'number') extra.index = hit.index;
      sendHotkey(hit.cmd, hit.phase || 'tap', extra);
      return;
    }

    // Typing in settings / license / voice sink — allow normal keys + ⌘C/V/…
    if (win.__padHotkeysSuspended) return;

    // Pad focused: swallow other modifier shortcuts so they can't steal focus
    if (meta || ctrl || alt) event.preventDefault();
  });
}

/** True when the preferred modifier is held (Caps Lock = lock LED on). */
function isModChord(mod, { meta, ctrl, alt, shift, primary }) {
  switch (mod) {
    case 'option':
      return alt && !primary && !ctrl && !shift;
    case 'control':
      return ctrl && !meta && !alt && !shift;
    case 'capslock':
      return capsLockOn && !meta && !ctrl && !alt && !shift;
    case 'command':
    default:
      return primary && !alt && !shift && (process.platform === 'darwin' ? !ctrl : true);
  }
}

/** Active modifier + QWERDF / arrows / 1–6 */
function matchPadChord(mod, flags, key, code) {
  if (!isModChord(mod, flags)) return null;

  // Prefer physical key code — Option on macOS often remaps `key` to symbols
  const codeLetter = /^Key([A-Z])$/.exec(code);
  const lower = codeLetter
    ? codeLetter[1].toLowerCase()
    : key.length === 1
      ? key.toLowerCase()
      : key;
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
  const winH = 596;

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
  mainWindow.webContents.on('console-message', (event) => {
    // Electron: prefer Event params object (legacy positional args deprecated)
    const level = event?.level ?? 0;
    const message = event?.message ?? '';
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
  for (const cwd of [...devServers.keys()]) stopDevServer(cwd);
  bridge?.stop();
  stopPadContextWatch();
  globalShortcut.unregisterAll();
});

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:setGitPanel', (_e, open) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const bounds = mainWindow.getBounds();
  const width = open ? 558 : 344;
  const right = bounds.x + bounds.width;
  // Keep the keyboard/header/HUD anchored to the same screen position. Only
  // reveal extra window space on the left, without macOS resize animation.
  mainWindow.setBounds({ x: right - width, y: bounds.y, width, height: bounds.height }, false);
  return true;
});
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
ipcMain.handle('codexSettings:save', async (_e, partial) => {
  if (trialLocked()) return trialDenied();
  if (partial?.sandbox_mode === 'danger-full-access' && partial?.approval_policy === 'never') {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: [i18n.t(padPrefs.getLocale(), 'settings.risk.cancel'), i18n.t(padPrefs.getLocale(), 'settings.risk.confirm')],
      defaultId: 0,
      cancelId: 0,
      title: i18n.t(padPrefs.getLocale(), 'settings.risk.title'),
      message: i18n.t(padPrefs.getLocale(), 'settings.risk.message'),
      detail: i18n.t(padPrefs.getLocale(), 'settings.risk.detail'),
    });
    if (response !== 1) return { ok: false, canceled: true, reason: 'risk-canceled' };
  }
  return codexSettings.save(partial || {});
});
ipcMain.handle('codexSettings:chooseWorkingDirectory', async () => {
  if (trialLocked()) return trialDenied();
  const r = await dialog.showOpenDialog(mainWindow, {
    title: i18n.t(padPrefs.getLocale(), 'settings.workingDirectory.choose'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? { ok: false, canceled: true } : { ok: true, path: r.filePaths?.[0] || '' };
});
ipcMain.handle('resources:getUsage', () => {
  const metrics = app.getAppMetrics();
  const totalKb = metrics.reduce((sum, metric) => sum + Number(metric.memory?.workingSetSize || 0), 0);
  return { ok: true, ramMb: Math.round(totalKb / 1024), processCount: metrics.length };
});
ipcMain.handle('mcp:list', async () => {
  if (trialLocked()) return trialDenied();
  return bridge?.listMcpServers?.() || { ok: false, servers: [], error: 'Codex unavailable' };
});
ipcMain.handle('mcp:setOptions', async (_e, name, options) => {
  if (trialLocked()) return trialDenied();
  try {
    return codexSettings.setMcpServerOptions(name, options || {});
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('mcp:command', async (_e, action, payload) => {
  if (trialLocked()) return trialDenied();
  if (action === 'remove') {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning', buttons: [i18n.t(padPrefs.getLocale(), 'mcp.cancel'), i18n.t(padPrefs.getLocale(), 'mcp.remove')],
      defaultId: 0, cancelId: 0, title: i18n.t(padPrefs.getLocale(), 'mcp.removeTitle'),
      message: i18n.t(padPrefs.getLocale(), 'mcp.removeMessage', { name: payload?.name || '' }),
    });
    if (response !== 1) return { ok: false, canceled: true };
  }
  return bridge?.mcpCommand?.(action, payload || {}) || { ok: false, error: 'Codex unavailable' };
});

function discoverSkills() {
  const roots = [path.join(os.homedir(), '.codex', 'skills'), path.join(os.homedir(), '.codex', 'plugins', 'cache')];
  const found = [];
  const walk = (dir, depth = 0) => {
    if (depth > 7 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name === 'SKILL.md') {
        const text = fs.readFileSync(full, 'utf8').slice(0, 12000);
        const front = text.match(/^---\s*\n([\s\S]*?)\n---/);
        const name = front?.[1].match(/^name:\s*["']?([^\n"']+)/m)?.[1]?.trim() || path.basename(path.dirname(full));
        const description = front?.[1].match(/^description:\s*["']?([^\n"']+)/m)?.[1]?.trim() || '';
        found.push({ name, description, path: full, source: full.includes('/plugins/') ? 'plugin' : full.includes('/.system/') ? 'system' : 'personal' });
      }
    }
  };
  roots.forEach((root) => walk(root));
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
ipcMain.handle('skills:list', async () => {
  if (trialLocked()) return trialDenied();
  const pluginResult = await bridge?.listPlugins?.();
  return { ok: true, skills: discoverSkills(), plugins: pluginResult?.plugins || [], pluginError: pluginResult?.ok ? null : pluginResult?.error };
});
ipcMain.handle('skills:personalList', () => ({ ok: true, skills: skillManager.personalSkills() }));
ipcMain.handle('skills:save', (_e, input) => {
  if (trialLocked()) return trialDenied();
  try { return skillManager.saveSkill(input || {}); } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('skills:delete', async (_e, name) => {
  if (trialLocked()) return trialDenied();
  try {
    const target = skillManager.skillPath(name);
    const { response } = await dialog.showMessageBox(mainWindow, { type: 'warning', buttons: [i18n.t(padPrefs.getLocale(), 'mcp.cancel'), i18n.t(padPrefs.getLocale(), 'skills.delete')], defaultId: 0, cancelId: 0, title: i18n.t(padPrefs.getLocale(), 'skills.deleteTitle'), message: i18n.t(padPrefs.getLocale(), 'skills.deleteMessage', { name }) });
    if (response !== 1) return { ok: false, canceled: true };
    await shell.trashItem(target);
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('icons:search', async (_e, rawQuery) => {
  if (trialLocked()) return trialDenied();
  const requestedQuery = String(rawQuery || '').trim().slice(0, 60);
  const query = /^codex(?: cli)?$/i.test(requestedQuery) ? 'openai' : requestedQuery;
  if (query.length < 2) return { ok: false, error: 'Enter at least 2 characters' };
  try {
    const url = `https://api.iconify.design/search?query=${encodeURIComponent(query)}&limit=24`;
    const response = await net.fetch(url);
    if (!response.ok) throw new Error(`Icon search failed (${response.status})`);
    const data = await response.json();
    const icons = (Array.isArray(data?.icons) ? data.icons : []).filter((id) => /^[a-z0-9-]+:[a-z0-9-]+$/.test(id)).slice(0, 24);
    return { ok: true, icons };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('icons:fetch', async (_e, rawId) => {
  if (trialLocked()) return trialDenied();
  const id = String(rawId || '').trim();
  const match = id.match(/^([a-z0-9-]+):([a-z0-9-]+)$/);
  if (!match) return { ok: false, error: 'Invalid icon ID' };
  try {
    const response = await net.fetch(`https://api.iconify.design/${match[1]}/${match[2]}.svg`);
    if (!response.ok) throw new Error(`Icon download failed (${response.status})`);
    let svg = await response.text();
    if (!/^\s*<svg\b/i.test(svg) || svg.length > 160000 || /<script|\bon\w+\s*=|javascript:|<foreignObject/i.test(svg)) throw new Error('Unsafe icon response');
    svg = svg.replace(/<\?xml[\s\S]*?\?>/gi, '').trim();
    return { ok: true, id, label: match[2].replace(/-/g, ' ').slice(0, 24), dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
  } catch (error) { return { ok: false, error: error.message }; }
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
ipcMain.handle('codexSettings:listBackups', () => ({ ok: true, backups: codexSettings.listBackups() }));
ipcMain.handle('codexSettings:restoreBackup', async (_e, id) => {
  const { response } = await dialog.showMessageBox(mainWindow, { type: 'warning', buttons: [i18n.t(padPrefs.getLocale(), 'settings.risk.cancel'), i18n.t(padPrefs.getLocale(), 'settings.restore')], defaultId: 0, cancelId: 0, title: i18n.t(padPrefs.getLocale(), 'settings.restoreTitle'), message: i18n.t(padPrefs.getLocale(), 'settings.restoreMessage') });
  if (response !== 1) return { ok: false, canceled: true };
  try { return codexSettings.restoreBackup(id); } catch (error) { return { ok: false, error: error.message }; }
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
function focusPadNow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setAlwaysOnTop(true, 'floating');
    mainWindow.setFocusable(true);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (typeof app.focus === 'function') app.focus({ steal: true });
  } catch (e) {
    console.log('[focusPad]', e.message);
  }
}

ipcMain.handle('voice:beginDictation', async () => {
  if (trialLocked()) return trialDenied();
  if (!bridge?.prepareVoiceDictation || !bridge?.beginVoiceDictation) {
    return { ok: false, error: 'dictation not supported' };
  }
  // 1) Ensure CLI exists without activating it (paste target for later)
  const prep = await bridge.prepareVoiceDictation();
  if (!prep?.ok) return prep;

  // 2) Steal focus back to pad so macOS dictation inserts into voice-sink
  focusPadNow();
  await new Promise((r) => setTimeout(r, prep.opened ? 220 : 100));
  focusPadNow();

  // 3) Start dictation while pad/sink is first-responder
  return bridge.beginVoiceDictation();
});
ipcMain.handle('voice:prepareCapture', async () => {
  if (trialLocked()) return trialDenied();
  return (await bridge?.prepareVoiceDictation?.()) || { ok: false, error: 'voice unavailable' };
});
ipcMain.handle('voice:transcribeAudio', async (_e, bytes, mimeType) => {
  if (trialLocked()) return trialDenied();
  const data = Buffer.from(bytes || []);
  if (!data.length) return { ok: false, code: 'EMPTY_AUDIO', error: 'empty audio' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-micro-voice-'));
  const wav = path.join(dir, 'voice.wav');
  const resourceRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'assets');
  const arch = process.arch === 'x64' ? 'darwin-x64' : 'darwin-arm64';
  const whisper = path.join(resourceRoot, 'bin', arch, 'whisper-cli');
  const model = path.join(resourceRoot, 'models', 'ggml-base.bin');
  try {
    if (!fs.existsSync(whisper)) return { ok: false, code: 'WHISPER_MISSING', error: `Whisper 없음: ${arch}` };
    if (!fs.existsSync(model)) return { ok: false, code: 'MODEL_MISSING', error: 'Whisper 모델 없음' };
    fs.writeFileSync(wav, data);
    let text = await new Promise((resolve, reject) => {
      execFile(whisper, ['-ng', '-m', model, '-f', wav, '-l', 'ko', '-nt', '-np', '-nf', '-sns'],
        { timeout: 90000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim()));
        else resolve(String(stdout || '').trim());
      });
    });
    // Whisper can repeat the same bracketed short utterance over silence.
    text = text.replace(/(\[[^\]]+\])(?:\s*\1)+/g, '$1').replace(/\s+/g, ' ').trim();
    const hallucinations = [
      '구독과 좋아요 부탁드립니다', '구독과 좋아요를 부탁드립니다',
      '시청해 주셔서 감사합니다', '시청해주셔서 감사합니다',
    ];
    if (hallucinations.some((phrase) => text.replace(/[.!?。]/g, '').includes(phrase))) {
      return { ok: false, code: 'NO_SPEECH', error: '인식된 음성이 없습니다' };
    }
    if (!text) return { ok: false, code: 'EMPTY_TRANSCRIPT', error: '인식된 음성이 없습니다' };
    const sent = await bridge?.submitVoiceText?.(text);
    return { ...(sent || { ok: false }), text };
  } catch (e) {
    return { ok: false, code: 'TRANSCRIBE', error: e.message };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    refocusPad(380);
  }
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
ipcMain.handle('codex:modelPicker', () => {
  if (trialLocked()) return trialDenied();
  return bridge?.openModelPicker();
});
ipcMain.handle('codex:switchModel', (_e, model) => {
  if (trialLocked()) return trialDenied();
  return bridge?.switchModel(model);
});
ipcMain.handle('devServer:toggle', () => {
  if (trialLocked()) return trialDenied();
  try {
    const cwd = selectedWorkspace();
    if (stopDevServer(cwd)) return { ok: true, running: false, cwd };
    const detected = detectDevCommand(cwd);
    const command = detected.command;
    const child = spawn('/bin/zsh', ['-lc', `exec ${command}`], { cwd, detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    child.unref();
    devServers.set(cwd, child);
    child.once('exit', () => { if (devServers.get(cwd) === child) devServers.delete(cwd); });
    child.once('error', () => { if (devServers.get(cwd) === child) devServers.delete(cwd); });
    return { ok: true, running: true, cwd, command, kind: detected.kind, pid: child.pid };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('devServer:status', () => {
  if (trialLocked()) return trialDenied();
  try {
    const cwd = selectedWorkspace();
    const child = devServers.get(cwd);
    const detected = detectDevCommand(cwd);
    return { ok: true, running: !!child, cwd, command: detected.command, kind: detected.kind };
  } catch (error) { return { ok: false, running: false, error: error.message }; }
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
