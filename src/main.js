const { app, BrowserWindow, ipcMain, screen, globalShortcut, shell, Menu, dialog, net, Tray, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const path = require('path');
const { createBridge, focusCodexDesktop } = require('./providers/create-bridge');
const codexSettings = require('./codex-settings');
const codexUsage = require('./codex-usage');
const padPrefs = require('./pad-prefs');
const i18n = require('./i18n');
const mac = require('./platform');
const skillManager = require('./skill-manager');
const whisperModel = require('./whisper-model');
const toolInstaller = require('./tool-installer');
const gitSetup = require('./git-setup');
const agentRules = require('./agent-rules');
const agentCoordinator = require('./agent-coordinator');
const promptRouting = require('./prompt-routing');
const { SKILLS } = require('./providers/base-bridge');
const { detectDevCommand } = require('./dev-runner');
const { findCodexNative } = require('./providers/codex-bridge');

let mainWindow = null;
let bridge = null;
let activeProvider = 'codex';
let statusTray = null;
let statusTrayTimer = null;
let statusTrayRefreshing = false;
let statusTrayUsage = null;
let coordinatorHealthTimer = null;
let coordinatorHealthBusy = false;
const devServers = new Map();
const routingModelLocks = Array.from({ length: 6 }, () => false);
let bodyDragState = null;

function trayResetText(epochSeconds) {
  if (!epochSeconds) return 'reset time unavailable';
  const seconds = Math.max(0, Number(epochSeconds) - Math.floor(Date.now() / 1000));
  if (seconds <= 0) return 'reset due now';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 24) return `reset in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `reset in ${hours}h ${minutes}m`;
}

function trayUsageTitle(rate) {
  const percent = Number(rate?.usedPercent);
  if (!Number.isFinite(percent)) return '—';
  const used = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round(used / 20);
  const graph = `${'▰'.repeat(filled)}${'▱'.repeat(5 - filled)}`;
  const reset = trayResetText(rate?.resetsAt).replace(/^reset in /, '').replace(/^reset /, '');
  return `${used}% ${graph} · ${reset}`;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  syncPadHotkeyContext();
}

function openTrayPanel(panel) {
  showMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('app:openPanel', panel);
}

function trayDurationLabel(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value % 3600 === 0) return `${value / 3600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
}

function trayTokenLabel(tokens) {
  const value = Number(tokens) || 0;
  if (value === 0) return 'Auto';
  if (value % 1000 === 0) return `${Math.round(value / 1000)}k`;
  return `${value}`;
}

function traySettingItems({ values, current, onSelect, format = (value) => String(value) }) {
  const options = [...new Set([...values, current])].sort((a, b) => a - b);
  return options.map((value) => ({
    label: format(value),
    type: 'radio',
    checked: Number(current) === Number(value),
    click: () => onSelect(value),
  }));
}

function trayToggleItem(label, checked, onToggle) {
  return {
    label: `${label} · ${checked ? 'On' : 'Off'}`,
    type: 'checkbox',
    checked: !!checked,
    click: (item) => onToggle(item.checked),
  };
}

function updateStatusTrayMenu(usage = null) {
  if (!statusTray) return;
  const settings = codexSettings.load();
  const rate = usage?.rateLimit;
  const pacing = usage?.usagePlan;
  const used = rate?.usedPercent != null ? `${rate.usedPercent}% used` : 'Usage unavailable';
  const reset = trayResetText(rate?.resetsAt);
  const title = trayUsageTitle(rate);
  const saveTraySetting = (partial) => {
    try {
      codexSettings.save(partial);
      refreshStatusTray();
    } catch {
      // The full settings window can show validation errors; keep the tray usable.
    }
  };
  const ramItems = traySettingItems({
    values: [1024, 2048, 4096, 8192, 16384],
    current: settings.ram_warning_mb,
    format: (value) => `${value >= 1024 ? `${value / 1024} GB` : `${value} MB`}`,
    onSelect: (value) => saveTraySetting({ ram_warning_mb: value }),
  });
  const runtimeItems = traySettingItems({
    values: [1800, 3600, 7200, 14400, 28800, 43200, 86400],
    current: settings.job_max_runtime_seconds,
    format: trayDurationLabel,
    onSelect: (value) => saveTraySetting({ job_max_runtime_seconds: value }),
  });
  const toolTimeoutItems = traySettingItems({
    values: [60, 300, 900, 1800, 3600],
    current: settings.tool_timeout_sec,
    format: trayDurationLabel,
    onSelect: (value) => saveTraySetting({ tool_timeout_sec: value }),
  });
  const startupTimeoutItems = traySettingItems({
    values: [10, 30, 60, 120, 300],
    current: settings.startup_timeout_sec,
    format: trayDurationLabel,
    onSelect: (value) => saveTraySetting({ startup_timeout_sec: value }),
  });
  const presetItems = ['saver', 'balanced', 'performance', 'custom'].map((value) => ({
    label: value[0].toUpperCase() + value.slice(1),
    type: 'radio',
    checked: settings.resource_preset === value,
    click: () => saveTraySetting({ resource_preset: value }),
  }));
  const threadItems = traySettingItems({
    values: [1, 2, 4, 6, 8, 12],
    current: settings.max_threads,
    format: (value) => `${value} agents`,
    onSelect: (value) => saveTraySetting({ max_threads: value }),
  });
  const depthItems = traySettingItems({
    values: [0, 1, 2, 3, 4],
    current: settings.max_depth,
    format: (value) => `${value} level${value === 1 ? '' : 's'}`,
    onSelect: (value) => saveTraySetting({ max_depth: value }),
  });
  const compactItems = traySettingItems({
    values: [0, 32000, 64000, 128000, 256000, 512000],
    current: settings.model_auto_compact_token_limit,
    format: trayTokenLabel,
    onSelect: (value) => saveTraySetting({ model_auto_compact_token_limit: value }),
  });
  const outputItems = traySettingItems({
    values: [0, 16000, 32000, 64000, 128000, 256000],
    current: settings.tool_output_token_limit,
    format: trayTokenLabel,
    onSelect: (value) => saveTraySetting({ tool_output_token_limit: value }),
  });
  const dailyUsageItems = traySettingItems({
    values: [5, 10, 15, 20, 25, 50, 100],
    current: settings.daily_usage_limit_percent,
    format: (value) => `${value}% per day`,
    onSelect: (value) => saveTraySetting({ daily_usage_limit_percent: value }),
  });
  const webSearchItems = ['', 'cached', 'indexed', 'live', 'disabled'].map((value) => ({
    label: value ? value[0].toUpperCase() + value.slice(1) : 'Auto',
    type: 'radio',
    checked: settings.web_search === value,
    click: () => saveTraySetting({ web_search: value }),
  }));
  const routingItems = [
    ['off', 'Off'],
    ['saver', 'Saver'],
    ['balanced', 'Balanced'],
    ['performance', 'Performance'],
  ].map(([value, label]) => ({
    label,
    type: 'radio',
    checked: settings.auto_routing_mode === value,
    click: () => saveTraySetting({ auto_routing_mode: value }),
  }));
  statusTray.setTitle(title);
  statusTray.setToolTip(`Codex · ${title}`);
  statusTray.setContextMenu(Menu.buildFromTemplate([
    { label: `Codex · ${used}`, enabled: false },
    { label: reset, enabled: false },
    ...(pacing?.available ? [
      {
        label: `Today ${pacing.todayUsedPercent ?? '—'}% · recommended ${pacing.recommendedTodayPercent ?? '—'}% more`,
        enabled: false,
      },
      { label: `Plan remaining ${pacing.remainingPercent}%`, enabled: false },
    ] : []),
    { type: 'separator' },
    { label: 'Open Agent Micro', click: showMainWindow },
    { label: 'Refresh usage', click: () => refreshStatusTray() },
    { type: 'separator' },
    { label: 'Settings', click: () => openTrayPanel('settings') },
    { label: 'Git', click: () => openTrayPanel('git') },
    { label: 'MCP', click: () => openTrayPanel('mcp') },
    { label: 'Skills & Plugins', click: () => openTrayPanel('skills') },
    { label: 'User Guide', click: () => openTrayPanel('guide') },
    { label: 'Key Map', click: () => openTrayPanel('keymap') },
    { label: 'Global Rules', click: () => openTrayPanel('rules') },
    { type: 'separator' },
    {
      label: 'Quick settings',
      submenu: [
        {
          label: 'Runtime & limits',
          submenu: [
            { label: 'Startup timeout', submenu: startupTimeoutItems },
            { label: 'Tool timeout', submenu: toolTimeoutItems },
            { label: 'Max job runtime', submenu: runtimeItems },
            { type: 'separator' },
            { label: 'Max parallel agents', submenu: threadItems },
            { label: 'Agent nesting depth', submenu: depthItems },
          ],
        },
        {
          label: 'Resources & context',
          submenu: [
            { label: `RAM warning · ${settings.ram_warning_mb} MB`, submenu: ramItems },
            { label: 'Resource preset', submenu: presetItems },
            { label: 'Auto-compact context', submenu: compactItems },
            { label: 'Tool output limit', submenu: outputItems },
            { label: `Token rollout budget · ${settings.rollout_budget_enabled ? 'On' : 'Off'}`, type: 'checkbox', checked: !!settings.rollout_budget_enabled, click: (item) => saveTraySetting({ rollout_budget_enabled: item.checked }) },
            trayToggleItem('Daily usage target', settings.daily_usage_limit_enabled, (value) => saveTraySetting({ daily_usage_limit_enabled: value })),
            { label: `Daily target · ${settings.daily_usage_limit_percent}%`, submenu: dailyUsageItems },
          ],
        },
        {
          label: 'Behavior',
          submenu: [
            {
              label: 'Default mode · work and edit',
              type: 'radio',
              checked: settings.interaction_mode !== 'ask',
              click: () => saveTraySetting({ interaction_mode: 'default' }),
            },
            {
              label: 'Ask mode · read only',
              type: 'radio',
              checked: settings.interaction_mode === 'ask',
              click: () => saveTraySetting({ interaction_mode: 'ask' }),
            },
            { type: 'separator' },
            { label: 'Automatic model routing', submenu: routingItems },
            trayToggleItem('Interrupt message', settings.interrupt_message, (value) => saveTraySetting({ interrupt_message: value })),
            trayToggleItem('Prevent idle sleep', settings.prevent_idle_sleep, (value) => saveTraySetting({ prevent_idle_sleep: value })),
            { label: 'Web search', submenu: webSearchItems },
          ],
        },
        { type: 'separator' },
        { label: 'Open full settings', click: showMainWindow },
      ],
    },
    { type: 'separator' },
    { label: 'Quit Agent Micro', click: () => app.quit() },
  ]));
}

async function refreshStatusTray() {
  if (!statusTray || statusTrayRefreshing || trialLocked()) return;
  statusTrayRefreshing = true;
  try {
    const rateLimitSnapshot = await bridge?.readRateLimits?.();
    const settings = codexSettings.load();
    const usage = codexUsage.getUsage({
      rateLimitSnapshot,
      dailyLimitEnabled: settings.daily_usage_limit_enabled,
      dailyLimitPercent: settings.daily_usage_limit_percent,
    });
    statusTrayUsage = usage;
    updateStatusTrayMenu(usage);
  } catch {
    statusTrayUsage = null;
    statusTray.setTitle('—');
    updateStatusTrayMenu(null);
  } finally {
    statusTrayRefreshing = false;
  }
}

function createStatusTray() {
  if (statusTray) return;
  // A title-only status item keeps the menu bar legible at small sizes.
  statusTray = new Tray(nativeImage.createEmpty());
  statusTray.setTitle('—');
  statusTray.on('click', showMainWindow);
  updateStatusTrayMenu();
  refreshStatusTray();
  statusTrayTimer = setInterval(refreshStatusTray, 10000);
}

function selectedWorkspace() {
  const agent = bridge?.agents?.[bridge?.selected || 0];
  const candidate = agent?.projectRoot || agent?.cwd || codexSettings.load()?.working_directory || process.cwd();
  const resolved = path.resolve(String(candidate || process.cwd()));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('Selected agent working folder is unavailable');
  return resolved;
}

function coordinatorWorkspace() {
  const configured = String(codexSettings.load()?.working_directory || '').trim();
  if (configured && path.isAbsolute(configured)) {
    try {
      if (fs.statSync(configured).isDirectory()) return path.resolve(configured);
    } catch {
      /* fall back to the selected live workspace */
    }
  }
  return selectedWorkspace();
}

async function launchIsolatedAgent(slotInput, options = {}) {
  const slot = Math.max(0, Math.min(5, Number(slotInput) || 0));
  const cwd = options.cwd || coordinatorWorkspace();
  let result = null;
  try {
    if (typeof bridge?.ensureAgentCliWindow === 'function') {
      // Terminal splits are ordered. Recreate missing predecessors quietly
      // before opening the assigned worker.
      for (let prerequisite = 0; prerequisite < slot; prerequisite += 1) {
        const prepared = await bridge.ensureAgentCliWindow(prerequisite, { focus: false });
        if (prepared?.ok === false) {
          result = prepared;
          break;
        }
      }
      if (!result) {
        result = options.focus === false
          ? await bridge.ensureAgentCliWindow(slot, { focus: false })
          : await bridge.select(slot, { focus: true });
      }
    } else {
      result = await bridge?.select?.(slot, { focus: options.focus !== false });
    }
    if (!result || typeof result !== 'object') result = { ok: true, slot };
  } catch (error) {
    result = { ok: false, slot, error: error.message };
  }
  await agentCoordinator.recordLaunch(cwd, slot, result, {
    automatic: !!options.automatic,
    trackOpen: activeProvider === 'codex',
  }).catch(() => {});
  return result;
}

async function monitorCoordinatorHealth() {
  if (coordinatorHealthBusy || !bridge || activeProvider !== 'codex') return;
  coordinatorHealthBusy = true;
  try {
    const cwd = coordinatorWorkspace();
    const openSlots = await mac.listOpenCodexCliSlots();
    const observed = await agentCoordinator.observeRuntime(cwd, openSlots, { claimRetries: true });
    for (const slot of observed.retries || []) {
      await launchIsolatedAgent(slot, { cwd, focus: false, automatic: true });
    }
  } catch {
    /* no valid Git workspace yet */
  } finally {
    coordinatorHealthBusy = false;
  }
}

function startCoordinatorHealthMonitor() {
  if (coordinatorHealthTimer) return;
  coordinatorHealthTimer = setInterval(monitorCoordinatorHealth, 5000);
  setTimeout(monitorCoordinatorHealth, 1500);
}

function stopDevServer(cwd) {
  const child = devServers.get(cwd);
  if (!child) return false;
  devServers.delete(cwd);
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  return true;
}

function trialLocked() {
  return false;
}

function trialDenied() {
  return { ok: false, error: 'unavailable' };
}
/** Global pad shortcuts armed while Codex CLI terminal is frontmost */
let cliPadGlobalsArmed = false;
let padContextTimer = null;
let lastFocusedCliSlotCheck = 0;

/** Base defs — modifier (⌘ ⌥ ⌃ ⇪) chosen in pad prefs */
const PAD_HOTKEY_DEFS = [
  { key: 'Q', cmd: 'fast' },
  { key: 'W', cmd: 'approve' },
  { key: 'E', cmd: 'decline' },
  { key: 'R', cmd: 'fork' },
  { key: 'D', cmd: 'review' },
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
    if (cliOurs) {
      registerCliPadGlobals();
      const now = Date.now();
      if (now - lastFocusedCliSlotCheck >= 500) {
        lastFocusedCliSlotCheck = now;
        const focusedSlot = await mac.getFocusedCliSlot?.();
        if (Number.isInteger(focusedSlot)) bridge?.syncSelectedSlot?.(focusedSlot);
      }
    } else unregisterCliPadGlobals();
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

    // Typing in settings / voice sink — allow normal keys + ⌘C/V/…
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
    d: { cmd: 'review' },
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
  const openPanel = (panel) => () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:openPanel', panel);
  };
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
    // These are intentionally top-level macOS menus so they are visible in
    // the system menu bar instead of being hidden inside one submenu.
    { label: 'Git', click: openPanel('git') },
    { label: 'MCP', click: openPanel('mcp') },
    { label: 'Skills & Plugins', click: openPanel('skills') },
    { label: 'User Guide', click: openPanel('guide') },
    { label: 'Key Map', click: openPanel('keymap') },
    { label: 'Settings', click: openPanel('settings') },
    { label: 'Global Rules', click: openPanel('rules') },
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
  // Keep the native transparent window at its expanded width permanently.
  // The right 558px hosts the pad; the transparent left rail is click-through
  // while closed. Avoiding native resize prevents macOS/WebGL redraw glitches.
  const baseWidth = 558;
  const railWidth = 210;
  const winW = baseWidth + railWidth;
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
  // Start in pass-through mode. The renderer still receives forwarded mouse
  // movement and turns interaction back on as soon as the pointer reaches a
  // visible control, while the closed transparent rail never eats a click.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  // Re-apply after the window exists as well. This keeps the macOS menu
  // available when dev mode reloads/recreates the BrowserWindow.
  installAppMenu();
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

function ensureBridge({ autoStart = true, provider } = {}) {
  if (bridge && (!provider || provider === activeProvider)) return bridge;
  const targetProvider = provider || activeProvider || 'codex';
  if (bridge) {
    bridge.stop();
    bridge.removeAllListeners('state');
    bridge.removeAllListeners('log');
  }
  bridge = createBridge(targetProvider);
  activeProvider = targetProvider;
  bindBridge(bridge);
  if (autoStart) setTimeout(() => bridge.start(), 200);
  return bridge;
}

/** Switch the active provider at runtime. */
async function switchProvider(provider) {
  if (!['codex', 'api'].includes(provider)) {
    return { ok: false, error: `Unknown provider: ${provider}` };
  }
  if (provider === activeProvider) return { ok: true, provider };
  if (bridge) {
    bridge.stop();
    bridge.removeAllListeners('state');
    bridge.removeAllListeners('log');
    bridge = null;
  }
  bridge = createBridge(provider);
  activeProvider = provider;
  bindBridge(bridge);
  return { ok: true, provider };
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  codexSettings.setUserDataPath(userData);
  padPrefs.setUserDataPath(userData);
  whisperModel.setUserDataPath(userData);
  toolInstaller.setUserDataPath(userData);

  installAppMenu();
  createWindow();
  createStatusTray();

  const locked = trialLocked();
  if (!locked) {
    // Reuse a configured custom model provider; otherwise start with Codex CLI.
    const savedSettings = codexSettings.load();
    const initialProvider = savedSettings.api_base_url && (savedSettings.api_model || savedSettings.model) ? 'api' : 'codex';
    bridge = createBridge(initialProvider);
    activeProvider = initialProvider;
    bindBridge(bridge);
    setTimeout(() => bridge.start(), 400);
    startCoordinatorHealthMonitor();
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
  app.on('before-quit', () => {
    if (statusTrayTimer) clearInterval(statusTrayTimer);
    statusTrayTimer = null;
    statusTray?.destroy();
    statusTray = null;
    if (coordinatorHealthTimer) clearInterval(coordinatorHealthTimer);
    coordinatorHealthTimer = null;
  });
});

function ensureUnlockedRuntime() {
  if (trialLocked()) return false;
  if (!bridge) {
    bridge = createBridge(activeProvider);
    bindBridge(bridge);
    setTimeout(() => bridge.start(), 200);
  }
  startCoordinatorHealthMonitor();
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
  if (coordinatorHealthTimer) clearInterval(coordinatorHealthTimer);
  coordinatorHealthTimer = null;
  stopPadContextWatch();
  globalShortcut.unregisterAll();
});

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:setGitPanel', (_e, open) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const baseWidth = 558;
  const extraWidth = 210;
  const bounds = mainWindow.getBounds();
  const targetWidth = baseWidth + extraWidth;
  const rightEdge = bounds.x + bounds.width;
  const targetX = rightEdge - targetWidth;
  if (bounds.width !== targetWidth || bounds.x !== targetX) {
    mainWindow.setBounds({ ...bounds, x: targetX, width: targetWidth }, false);
  }
  return { ok: true, open: !!open, fixedWindow: true, bounds: mainWindow.getBounds() };
});
ipcMain.handle('window:setMousePassthrough', (_e, passthrough) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.setIgnoreMouseEvents(!!passthrough, { forward: true });
  return true;
});
ipcMain.handle('git:status', async () => {
  if (trialLocked()) return trialDenied();
  try {
    const cwd = selectedWorkspace();
    const runGit = (args) => new Promise((resolve, reject) => {
      execFile('git', args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim()));
        else resolve(String(stdout || ''));
      });
    });
    const output = await runGit(['status', '--porcelain=v1', '--branch', '-z']);
    let remote = '';
    try {
      remote = (await runGit(['remote', 'get-url', 'origin'])).trim()
        .replace(/:\/\/[^/@]+@/, '://');
    } catch {}
    const entries = output.split('\0').filter(Boolean);
    const branchLine = entries[0]?.startsWith('## ') ? entries.shift().slice(3) : '';
    const branch = branchLine.split(/\.\.\.|\s/)[0] || 'HEAD';
    const upstream = branchLine.match(/\.\.\.([^\s\[]+)/)?.[1] || '';
    const tracking = branchLine.match(/\[(.+)\]/)?.[1] || '';
    const ahead = Number(tracking.match(/ahead\s+(\d+)/)?.[1] || 0);
    const behind = Number(tracking.match(/behind\s+(\d+)/)?.[1] || 0);
    const files = [];
    for (let i = 0; i < entries.length; i++) {
      const line = entries[i];
      const renamed = line[0] === 'R' || line[0] === 'C' || line[1] === 'R' || line[1] === 'C';
      const gitPath = line.slice(3);
      const oldPath = renamed ? entries[++i] || '' : '';
      files.push({
        status: line.slice(0, 2).trim() || '?',
        indexStatus: line[0] || ' ',
        worktreeStatus: line[1] || ' ',
        staged: line[0] !== ' ' && line[0] !== '?',
        path: oldPath ? `${oldPath} → ${gitPath}` : gitPath,
        gitPath,
      });
    }
    return { ok: true, cwd, branch, upstream, tracking, ahead, behind, remote, files, clean: files.length === 0 };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('git:stageFile', async (_e, file, staged) => {
  if (trialLocked()) return trialDenied();
  const target = String(file || '').trim();
  if (!target || target.includes('\0')) return { ok: false, error: 'Invalid file path' };
  try {
    const cwd = selectedWorkspace();
    const args = staged ? ['restore', '--staged', '--', target] : ['add', '--', target];
    await new Promise((resolve, reject) => {
      execFile('git', args, { cwd, timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || stdout || error.message).trim()));
        else resolve();
      });
    });
    return { ok: true, staged: !staged, file: target };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('git:stageAll', async () => {
  if (trialLocked()) return trialDenied();
  try {
    const cwd = selectedWorkspace();
    const run = (args) => new Promise((resolve, reject) => {
      execFile('git', args, { cwd, timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || stdout || error.message).trim()));
        else resolve(String(stdout || ''));
      });
    });
    await run(['add', '-A']);
    const staged = (await run(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
    return { ok: true, count: staged.length };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('git:unstageAll', async () => {
  if (trialLocked()) return trialDenied();
  try {
    const cwd = selectedWorkspace();
    await new Promise((resolve, reject) => {
      execFile('git', ['reset', 'HEAD', '--', '.'], { cwd, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || stdout || error.message).trim()));
        else resolve();
      });
    });
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('git:autoMessage', async () => {
  if (trialLocked()) return trialDenied();
  try {
    const cwd = selectedWorkspace();
    const gitOutput = (args) => new Promise((resolve, reject) => {
      execFile('git', args, { cwd, timeout: 10000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || stdout || error.message).trim()));
        else resolve(String(stdout || ''));
      });
    });
    const names = await gitOutput(['diff', '--cached', '--name-status']);
    if (!names.trim()) return { ok: false, error: 'Stage changes before generating a commit message' };
    const stat = await gitOutput(['diff', '--cached', '--stat']);
    const diff = (await gitOutput(['diff', '--cached', '--no-ext-diff', '--unified=1'])).slice(0, 48000);
    const prompt = `Write one concise Git commit subject for the staged changes below.\nRules: output only the subject; no quotes, markdown, body, or period; use imperative English; maximum 72 characters.\n\nFILES:\n${names}\nSTAT:\n${stat}\nDIFF:\n${diff}`;
    const found = findCodexNative();
    if (!found) throw new Error('Bundled Codex CLI is unavailable');
    const command = typeof found === 'object' ? process.execPath : String(found);
    const prefix = typeof found === 'object' ? [found.path] : [];
    const args = [...prefix, 'exec', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="low"', '-'];
    const message = await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: typeof found === 'object' ? '1' : '' } });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Commit message generation timed out')); }, 60000);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(stderr.trim() || `Codex exited with ${code}`));
        else resolve(stdout.trim());
      });
      child.stdin.end(prompt);
    });
    const subject = String(message).split(/\r?\n/).filter(Boolean).pop()?.replace(/^[`"']+|[`"']+$/g, '').slice(0, 120).trim();
    if (!subject) throw new Error('Codex returned an empty commit message');
    return { ok: true, message: subject, model: 'gpt-5.6-luna' };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('git:commit', async (_e, message) => {
  if (trialLocked()) return trialDenied();
  const subject = String(message || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
  if (!subject) return { ok: false, error: 'Enter a commit message' };
  try {
    const cwd = selectedWorkspace();
    const output = await new Promise((resolve, reject) => {
      execFile('git', ['commit', '-m', subject], { cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || stdout || error.message).trim()));
        else resolve(String(stdout || '').trim());
      });
    });
    return { ok: true, output };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('git:sync', async (_e, action, context = {}) => {
  if (trialLocked()) return trialDenied();
  const mode = action === 'pull' ? 'pull' : action === 'push' ? 'push' : null;
  if (!mode) return { ok: false, error: 'Unsupported Git action' };
  try {
    const cwd = selectedWorkspace();
    const branch = String(context?.branch || '').trim();
    const publish = mode === 'push' && !context?.upstream && branch && branch !== 'HEAD';
    const args = mode === 'pull'
      ? ['pull', '--ff-only']
      : publish ? ['push', '-u', 'origin', branch] : ['push'];
    const output = await new Promise((resolve, reject) => {
      execFile('git', args, { cwd, timeout: 120000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || stdout || error.message).trim()));
        else resolve(String(stdout || stderr || '').trim());
      });
    });
    return { ok: true, action: mode, output };
  } catch (error) { return { ok: false, action: mode, error: error.message }; }
});
ipcMain.handle('coordinator:list', async () => {
  try {
    const cwd = coordinatorWorkspace();
    const openSlots = await mac.listOpenCodexCliSlots().catch(() => []);
    await agentCoordinator.observeRuntime(cwd, openSlots);
    return await agentCoordinator.list(cwd);
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('coordinator:create', async (_e, input) => {
  try {
    const cwd = coordinatorWorkspace();
    const result = await agentCoordinator.createTask(cwd, input);
    if (!result?.ok) return result;
    const slot = result.record.slot;
    const settings = codexSettings.load();
    const slots = settings.agent_slots.map((entry) => ({ ...entry }));
    slots[slot] = {
      ...slots[slot],
      enabled: true,
      name: String(input?.task || `Agent ${slot + 1}`).trim().slice(0, 80),
      working_directory: result.record.worktree,
    };
    codexSettings.save({ agent_slots: slots });
    if (bridge?.agents?.[slot]) {
      bridge.agents[slot].cwd = result.record.worktree;
      bridge.agents[slot].projectRoot = result.record.worktree;
      bridge.agents[slot].projectName = path.basename(result.record.worktree);
    }
    bridge?.emitState?.(`Agent ${slot + 1} · isolated`);
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('coordinator:launch', async (_e, slotInput) => {
  try {
    const slot = Math.max(0, Math.min(5, Number(slotInput) || 0));
    return await launchIsolatedAgent(slot, { cwd: coordinatorWorkspace(), focus: true });
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('coordinator:merge', async (_e, slot) => {
  try {
    return await agentCoordinator.mergeTask(coordinatorWorkspace(), slot);
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('coordinator:restore', async (_e, slot) => {
  try {
    return await agentCoordinator.restoreTask(coordinatorWorkspace(), slot);
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('coordinator:archive', async (_e, slot) => {
  try {
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Clean up'],
      defaultId: 0,
      cancelId: 0,
      title: 'Clean up Agent worktree',
      message: `Agent ${Number(slot) + 1}의 완료된 worktree와 브랜치를 정리할까요?`,
      detail: '병합되지 않은 커밋이나 수정 중인 파일이 있으면 정리되지 않습니다.',
    });
    if (answer.response !== 1) return { ok: false, canceled: true };
    const result = await agentCoordinator.archiveTask(coordinatorWorkspace(), slot);
    if (result?.ok) {
      const settings = codexSettings.load();
      const slots = settings.agent_slots.map((entry) => ({ ...entry }));
      slots[Number(slot)] = { ...slots[Number(slot)], working_directory: '' };
      codexSettings.save({ agent_slots: slots });
    }
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('window:suspendPadHotkeys', (_e, suspended) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.__padHotkeysSuspended = !!suspended;
  }
  return true;
});
ipcMain.on('window:bodyDrag', (event, payload = {}) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  const phase = payload.phase;
  const pointerX = Number(payload.x);
  const pointerY = Number(payload.y);
  if (phase === 'end' || !Number.isFinite(pointerX) || !Number.isFinite(pointerY)) {
    bodyDragState = null;
    return;
  }
  if (phase === 'start') {
    const [windowX, windowY] = mainWindow.getPosition();
    bodyDragState = { pointerX, pointerY, windowX, windowY };
    return;
  }
  if (phase !== 'move' || !bodyDragState) return;
  const dx = pointerX - bodyDragState.pointerX;
  const dy = pointerY - bodyDragState.pointerY;
  if (Math.abs(dx) > 10000 || Math.abs(dy) > 10000) return;
  mainWindow.setPosition(
    Math.round(bodyDragState.windowX + dx),
    Math.round(bodyDragState.windowY + dy),
    false
  );
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
  let merged;
  try {
    merged = { ...codexSettings.load(), ...(partial || {}) };
    codexSettings.validateWritableRoots(codexSettings.normalize(merged).writable_roots);
    codexSettings.validateAgentSlots(codexSettings.normalize(merged).agent_slots);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const safetyWarnings = codexSettings.safetyWarnings(merged);
  if (safetyWarnings.length) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: [i18n.t(padPrefs.getLocale(), 'settings.risk.cancel'), i18n.t(padPrefs.getLocale(), 'settings.risk.confirm')],
      defaultId: 0,
      cancelId: 0,
      title: i18n.t(padPrefs.getLocale(), 'settings.risk.title'),
      message: i18n.t(padPrefs.getLocale(), 'settings.risk.message'),
      detail: `${i18n.t(padPrefs.getLocale(), 'settings.risk.detail')}\n\n${safetyWarnings.map((warning) => `• ${warning}`).join('\n')}`,
    });
    if (response !== 1) return { ok: false, canceled: true, reason: 'risk-canceled' };
  }
  const result = codexSettings.save(partial || {});
  if (result?.ok) updateStatusTrayMenu(statusTrayUsage);
  return result;
});
ipcMain.handle('codexSettings:chooseWorkingDirectory', async () => {
  if (trialLocked()) return trialDenied();
  const r = await dialog.showOpenDialog(mainWindow, {
    title: i18n.t(padPrefs.getLocale(), 'settings.workingDirectory.choose'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? { ok: false, canceled: true } : { ok: true, path: r.filePaths?.[0] || '' };
});
function rulesWorkingDirectory(cwd) {
  const candidates = [
    cwd,
    bridge?.agents?.[bridge?.selected || 0]?.projectRoot,
    bridge?.agents?.[bridge?.selected || 0]?.cwd,
    codexSettings.load().working_directory,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    try { if (path.isAbsolute(value) && fs.statSync(value).isDirectory()) return value; } catch {}
  }
  return '';
}
ipcMain.handle('agentRules:getProject', (_event, cwd) => {
  if (trialLocked()) return trialDenied();
  return agentRules.loadProject(rulesWorkingDirectory(cwd));
});
ipcMain.handle('agentRules:saveProject', (_event, cwd, rules) => {
  if (trialLocked()) return trialDenied();
  try {
    return agentRules.saveProject(rulesWorkingDirectory(cwd), rules);
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('resources:getUsage', () => {
  const metrics = app.getAppMetrics();
  const totalKb = metrics.reduce((sum, metric) => sum + Number(metric.memory?.workingSetSize || 0), 0);
  return { ok: true, ramMb: Math.round(totalKb / 1024), processCount: metrics.length };
});
ipcMain.handle('codex:usage', async () => {
  const current = bridge?.agents?.[bridge?.selected]?.rolloutPath || null;
  const rateLimitSnapshot = await bridge?.readRateLimits?.();
  const settings = codexSettings.load();
  return codexUsage.getUsage({
    currentRolloutPath: current,
    rateLimitSnapshot,
    dailyLimitEnabled: settings.daily_usage_limit_enabled,
    dailyLimitPercent: settings.daily_usage_limit_percent,
  });
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
  if (action === 'add') {
    const type = payload?.type === 'stdio' ? 'stdio' : payload?.type === 'http' ? 'http' : '';
    if (!type) return { ok: false, error: 'Unsupported MCP transport' };
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: [i18n.t(padPrefs.getLocale(), 'mcp.cancel'), i18n.t(padPrefs.getLocale(), 'mcp.addConfirm')],
      defaultId: 0,
      cancelId: 0,
      title: i18n.t(padPrefs.getLocale(), 'mcp.addTitle'),
      message: i18n.t(padPrefs.getLocale(), 'mcp.addMessage', { name: payload?.name || '', target: type === 'stdio' ? payload?.command || '' : payload?.url || '' }),
      detail: i18n.t(padPrefs.getLocale(), 'mcp.addDetail'),
    });
    if (response !== 1) return { ok: false, canceled: true };
  }
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
ipcMain.handle('voice:ensureModel', async () => {
  if (trialLocked()) return trialDenied();
  try {
    return await whisperModel.ensureModel((progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('voice:modelProgress', progress);
      }
    });
  } catch (error) {
    return { ok: false, code: 'MODEL_DOWNLOAD', error: error.message };
  }
});
ipcMain.handle('tools:ensure', async (_event, provider) => {
  if (trialLocked()) return trialDenied();
  // Custom APIs still use the Codex CLI agent runtime, so ensure that binary.
  if (provider === 'api') provider = 'codex';
  if (provider !== 'codex') return { ok: false, error: 'Only Codex CLI is supported' };
  try {
    return await toolInstaller.install(provider, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tools:progress', { provider, ...progress });
      }
    });
  } catch (error) {
    return { ok: false, code: 'TOOL_DOWNLOAD', error: error.message };
  }
});
ipcMain.handle('git:setupStatus', async () => {
  try {
    return await gitSetup.detectGit();
  } catch (error) {
    return { ok: false, installed: false, error: error.message };
  }
});
ipcMain.handle('git:install', async () => {
  try {
    return await gitSetup.installGit({ openExternal: (url) => shell.openExternal(url) });
  } catch (error) {
    return { ok: false, installed: false, error: error.message };
  }
});
ipcMain.handle('github:status', async () => {
  try {
    return await gitSetup.detectGitHub();
  } catch (error) {
    return { ok: false, connected: false, error: error.message };
  }
});
ipcMain.handle('github:connect', async () => {
  try {
    return await gitSetup.connectGitHub({ openExternal: (url) => shell.openExternal(url) });
  } catch (error) {
    return { ok: false, connected: false, error: error.message };
  }
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
  const model = whisperModel.findModel();
  try {
    if (!fs.existsSync(whisper)) return { ok: false, code: 'WHISPER_MISSING', error: `Whisper 없음: ${arch}` };
    if (!model || !fs.existsSync(model)) return { ok: false, code: 'MODEL_MISSING', error: 'Whisper 모델을 먼저 설치하세요' };
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
    const prepared = await preparePrompt(text, { source: 'voice' });
    if (!prepared.ok) return prepared;
    const sent = await bridge?.submitVoiceText?.(text);
    return { ...(sent || { ok: false }), text, preflight: prepared.preflight };
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
  const prepared = await preparePrompt(text, { source: 'voice' });
  if (!prepared.ok) return prepared;
  let r = { ok: false };
  try {
    r = (await bridge?.submitVoiceText?.(text)) || { ok: false };
  } finally {
    refocusPad(380);
  }
  return { ...r, preflight: prepared.preflight };
});

ipcMain.handle('codex:getState', async () => {
  if (trialLocked()) return null;
  await bridge?.refreshAgentContexts?.().catch(() => {});
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

async function readCurrentUsage(settings = codexSettings.load()) {
  const rateLimitSnapshot = await bridge?.readRateLimits?.();
  return codexUsage.getUsage({
    currentRolloutPath: bridge?.agents?.[bridge?.selected]?.rolloutPath || null,
    rateLimitSnapshot,
    dailyLimitEnabled: settings.daily_usage_limit_enabled,
    dailyLimitPercent: settings.daily_usage_limit_percent,
  });
}

function routingWarningDetail(preflight, usage) {
  const locale = padPrefs.getLocale();
  const ko = locale === 'ko';
  const estimate = preflight.estimate;
  const warning = preflight.warning;
  const plan = usage.usagePlan || {};
  const lines = [
    ko
      ? `복잡도 ${preflight.analysis.score}/100 · ${preflight.route.model || '현재 모델'} · 추론 ${preflight.route.reasoning || '자동'}`
      : `Complexity ${preflight.analysis.score}/100 · ${preflight.route.model || 'current model'} · reasoning ${preflight.route.reasoning || 'auto'}`,
    ko
      ? `예상 토큰 ${estimate.lowTokens.toLocaleString()}–${estimate.highTokens.toLocaleString()}`
      : `Estimated tokens ${estimate.lowTokens.toLocaleString()}–${estimate.highTokens.toLocaleString()}`,
  ];
  if (estimate.highPercent != null) {
    lines.push(ko
      ? `예상 플랜 사용 증가 ${estimate.lowPercent}–${estimate.highPercent}%`
      : `Estimated plan usage increase ${estimate.lowPercent}–${estimate.highPercent}%`);
  }
  if (warning.dailyWarning) {
    lines.push(ko
      ? `오늘 예상 사용량 ${warning.projectedToday}% · 설정 목표 ${plan.limitPercent}%`
      : `Projected today ${warning.projectedToday}% · target ${plan.limitPercent}%`);
  }
  if (warning.planWarning) {
    lines.push(ko
      ? `요청 후 플랜 사용량 최대 약 ${warning.projectedPlan}%`
      : `Projected plan usage up to about ${warning.projectedPlan}%`);
  }
  lines.push(ko
    ? `최근 실제 요청 ${estimate.learnedSamples}개를 기준으로 한 범위 추정입니다.`
    : `Range estimate learned from ${estimate.learnedSamples} recent request(s).`);
  return lines.join('\n');
}

async function preparePrompt(text, { source = 'prompt' } = {}) {
  const settings = codexSettings.load();
  let usage;
  try {
    usage = await readCurrentUsage(settings);
  } catch {
    usage = { current: {}, usagePlan: {}, usageStats: {}, todayTokens: 0 };
  }
  if (settings.daily_usage_limit_enabled && usage.usagePlan?.overDailyLimit) {
    const ko = padPrefs.getLocale() === 'ko';
    return {
      ok: false,
      code: 'DAILY_USAGE_LIMIT',
      error: ko
        ? `일일 사용량 목표(${settings.daily_usage_limit_percent}%)에 도달했습니다. 계속하려면 설정에서 목표를 끄거나 높이세요.`
        : `Daily usage target reached (${settings.daily_usage_limit_percent}%). Disable or raise it in Settings to continue from Agent Micro.`,
      usagePlan: usage.usagePlan,
    };
  }
  const slot = Math.max(0, Math.min(5, Number(bridge?.selected) || 0));
  const activeModel = String(bridge?.agents?.[slot]?.model || '').trim();
  const providerPinnedModel = settings.api_base_url && settings.api_model
    ? settings.api_model
    : '';
  const baseRoutingSettings = providerPinnedModel
    ? { ...settings, model: providerPinnedModel }
    : settings;
  const continuation = source === 'automatic' || source === 'continuation';
  const routingSettings = continuation
    ? {
      ...baseRoutingSettings,
      auto_routing_mode: 'off',
      model: activeModel || baseRoutingSettings.model,
      model_reasoning_effort: bridge?.agents?.[slot]?.reasoning || baseRoutingSettings.model_reasoning_effort,
    }
    : routingModelLocks[slot] && activeModel
    ? { ...baseRoutingSettings, model: activeModel }
    : baseRoutingSettings;
  const preflight = promptRouting.preflightPrompt(text, routingSettings, usage);
  if (preflight.warning.required && source !== 'automatic') {
    const ko = padPrefs.getLocale() === 'ko';
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: [ko ? '취소' : 'Cancel', ko ? '그래도 전송' : 'Send anyway'],
      defaultId: 0,
      cancelId: 0,
      title: ko ? '사용량 한계 임박' : 'Usage limit approaching',
      message: ko
        ? '이 요청은 설정한 사용량 목표를 넘을 가능성이 있습니다.'
        : 'This request may exceed your configured usage target.',
      detail: routingWarningDetail(preflight, usage),
    });
    if (response !== 1) return { ok: false, canceled: true, code: 'ROUTING_WARNING_CANCELED', preflight };
  } else if (preflight.warning.required && source === 'automatic') {
    return {
      ok: false,
      code: 'ROUTING_WARNING',
      error: padPrefs.getLocale() === 'ko'
        ? '예상 사용량이 목표를 넘을 수 있어 자동 Continue를 멈췄습니다.'
        : 'Automatic Continue stopped because projected usage may exceed the target.',
      preflight,
    };
  }

  let applied = null;
  if (preflight.route.enabled) {
    applied = await bridge?.applyRouting?.({
      model: preflight.route.model,
      reasoning: preflight.route.reasoning,
    });
  }
  const decision = { ...preflight, applied, source };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('routing:decision', decision);
  }
  return { ok: true, preflight: decision };
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
ipcMain.handle('codex:send', async (_e, text, options = {}) => {
  if (trialLocked()) return trialDenied();
  const prepared = await preparePrompt(text, {
    source: options?.source === 'automatic'
      ? 'automatic'
      : options?.source === 'continuation'
        ? 'continuation'
        : 'prompt',
  });
  if (!prepared.ok) return prepared;
  const result = await withCliFocus(() => bridge?.send(text));
  return { ...(result || { ok: false }), preflight: prepared.preflight };
});
ipcMain.handle('codex:clearInput', async () => {
  if (trialLocked()) return trialDenied();
  try {
    const slot = Math.max(0, Math.min(5, Number(bridge?.selected) || 0));
    return await withCliFocus(() => mac.clearCliInput(slot));
  } catch (error) {
    return { ok: false, error: error.message };
  }
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
  const slot = Math.max(0, Math.min(5, Number(bridge?.selected) || 0));
  routingModelLocks[slot] = true;
  return bridge?.openModelPicker();
});
ipcMain.handle('codex:switchModel', (_e, model) => {
  if (trialLocked()) return trialDenied();
  const slot = Math.max(0, Math.min(5, Number(bridge?.selected) || 0));
  routingModelLocks[slot] = true;
  return bridge?.switchModel(model);
});
ipcMain.handle('devServer:toggle', () => {
  if (trialLocked()) return trialDenied();
  try {
    const cwd = selectedWorkspace();
    if (stopDevServer(cwd)) return { ok: true, running: false, cwd };
    const detected = detectDevCommand(cwd);
    const command = detected.command;
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh';
    const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-lc', `exec ${command}`];
    const child = spawn(shell, shellArgs, { cwd, detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
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
  const prepared = await preparePrompt(SKILLS[name] || SKILLS.continue, {
    source: name === 'continue' ? 'continuation' : 'skill',
  });
  if (!prepared.ok) return prepared;
  // skill → send() into CLI; must steal pad focus like Send
  const result = await withCliFocus(() => bridge?.skill(name));
  return { ...(result || { ok: true }), preflight: prepared.preflight };
});
ipcMain.handle('codex:newChat', async () => {
  if (trialLocked()) return trialDenied();
  const result = await withCliFocus(() => bridge?.newChat());
  if (result?.ok && Number.isInteger(result.slot)) routingModelLocks[result.slot] = false;
  return result;
});
ipcMain.handle('codex:desktop', async (_e, action) => {
  if (trialLocked()) return trialDenied();
  // Legacy name — maps to CLI agent/nav helpers in the bridge
  return bridge?.desktopAction(action);
});
ipcMain.handle('codex:voice', async (_e, text) => {
  if (trialLocked()) return trialDenied();
  const prepared = await preparePrompt(text, { source: 'voice' });
  if (!prepared.ok) return prepared;
  if (!bridge?.voiceToCodex) {
    await bridge?.send?.(text);
    return { ok: true, mode: 'send-only', preflight: prepared.preflight };
  }
  const result = await bridge.voiceToCodex(text);
  return { ...(result || { ok: false }), preflight: prepared.preflight };
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
ipcMain.handle('codex:loginStatus', async () => {
  if (trialLocked()) return { ok: false, trialExpired: true };

  let codexStatus = { hasCodex: false, loggedIn: false };

  try {
    const { CodexBridge, findCodexNative } = require('./providers/codex-bridge');
    if (findCodexNative()) {
      const tempBridge = new CodexBridge({ customProvider: activeProvider === 'api' });
      codexStatus = await tempBridge.checkLogin();
    } else {
      codexStatus = { hasCodex: false, loggedIn: false };
    }
  } catch { /* ignore */ }

  return {
    hasCodex: codexStatus.hasCodex,
    hasBinary: false,
    loggedIn: codexStatus.loggedIn,
    codex: codexStatus,
    currentProvider: activeProvider,
  };
});
ipcMain.handle('codex:switchProvider', async (_e, provider) => {
  if (trialLocked()) return trialDenied();
  const result = await switchProvider(provider);
  if (result.ok && bridge) {
    await bridge.connect().catch(() => {});
  }
  return result;
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
