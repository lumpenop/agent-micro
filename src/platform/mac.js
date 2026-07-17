/**
 * macOS helpers — focus Codex Desktop + inject shortcuts via System Events.
 * Requires Accessibility permission for keystrokes.
 *
 * All pad actions go through this desktop path (not CLI app-server).
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { t } = require('../i18n');
const padPrefs = require('../pad-prefs');

function lt(key, vars) {
  return t(padPrefs.getLocale(), key, vars);
}

const CLI_SESSION_PATH = path.join(os.homedir(), '.agent-micro', 'cli-slots.json');

function osa(script, opts = {}) {
  const timeout = Math.max(500, Number(opts.timeout) || 8000);
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(String(stdout || '').trim());
    });
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function frontmostAppName() {
  try {
    return await osa(
      'tell application "System Events" to get name of first application process whose frontmost is true'
    );
  } catch {
    return '';
  }
}

/** True if frontmost looks like OpenAI Codex / ChatGPT — not Cursor. */
function isCodexFrontmost(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (n.includes('cursor')) return false;
  if (n.includes('electron') && !n.includes('codex')) return false;
  return n.includes('codex') || n.includes('chatgpt') || n.includes('openai');
}

/**
 * Activate OpenAI Codex desktop (never Cursor).
 * @returns {{ ok: boolean, app: string, reason?: string }}
 */
async function focusCodexApp() {
  const attempts = [
    'tell application id "com.openai.codex" to activate',
    'tell application "Codex" to activate',
    'tell application id "com.openai.chat" to activate',
    'tell application "ChatGPT" to activate',
  ];

  for (const script of attempts) {
    try {
      await osa(script);
      await delay(220);
      const front = await frontmostAppName();
      if (isCodexFrontmost(front)) {
        return { ok: true, app: front };
      }
    } catch {
      /* try next */
    }
  }

  // last resort: open by bundle id
  try {
    await new Promise((resolve, reject) => {
      execFile('open', ['-b', 'com.openai.codex'], (err) => (err ? reject(err) : resolve()));
    });
    await delay(500);
    const front = await frontmostAppName();
    if (isCodexFrontmost(front)) return { ok: true, app: front };
  } catch {
    /* ignore */
  }

  const front = await frontmostAppName();
  return {
    ok: false,
    app: front || '',
    reason: front
      ? `frontmost is ${front} · open Codex app`
      : 'Codex app not found',
  };
}

async function ensureCodexFocused() {
  const focus = await focusCodexApp();
  if (!focus.ok) {
    const err = new Error(focus.reason || 'Codex focus failed');
    err.code = 'NO_CODEX_APP';
    throw err;
  }
  await delay(100);
  const front = await frontmostAppName();
  if (!isCodexFrontmost(front)) {
    const err = new Error(lt('bridge.wrongApp', { app: front || '?' }));
    err.code = 'WRONG_APP';
    throw err;
  }
  return focus;
}

/**
 * Send a key to the focused Codex app (must already be focused, or pass { focus: true }).
 * @param {string} key
 * @param {Array<'command'|'option'|'shift'|'control'>} mods
 */
async function sendKey(key, mods = []) {
  const using = [];
  if (mods.includes('command')) using.push('command down');
  if (mods.includes('option')) using.push('option down');
  if (mods.includes('shift')) using.push('shift down');
  if (mods.includes('control')) using.push('control down');
  const usingClause = using.length ? ` using {${using.join(', ')}}` : '';

  const specials = {
    left: 123,
    right: 124,
    down: 125,
    up: 126,
    return: 36,
    escape: 53,
    tab: 48,
    delete: 51,
  };

  if (specials[key] != null) {
    return osa(`tell application "System Events" to key code ${specials[key]}${usingClause}`);
  }

  const escaped = String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return osa(`tell application "System Events" to keystroke "${escaped}"${usingClause}`);
}

/**
 * Focus Codex then send a shortcut. Same path the working joystick uses.
 * @param {string} key
 * @param {Array<'command'|'option'|'shift'|'control'>} mods
 */
async function keystroke(key, mods = []) {
  await ensureCodexFocused();
  await delay(80);
  return sendKey(key, mods);
}

/** Named desktop actions → Codex app shortcuts */
const DESKTOP_ACTIONS = {
  historyBack: { key: '[', mods: ['command'], label: 'history ←' },
  historyForward: { key: ']', mods: ['command'], label: 'history →' },
  sidebar: { key: 'b', mods: ['command'], label: 'sidebar' },
  composer: { key: 'k', mods: ['command'], label: 'composer' },
  newChat: { key: 'n', mods: ['command'], label: 'new chat' },
  newDesktopChat: { key: 'n', mods: ['command'], label: 'new chat' },
  settings: { key: ',', mods: ['command'], label: 'settings' },
  /** approval overlay (Codex): y / n / a */
  approve: { key: 'y', mods: [], label: 'approve · y' },
  decline: { key: 'n', mods: [], label: 'decline · n' },
  approveSession: { key: 'a', mods: [], label: 'approve session · a' },
  escape: { key: 'escape', mods: [], label: 'escape' },
  submit: { key: 'return', mods: [], label: 'submit' },
  /** common toggle-ish bindings — may vary by Codex keymap */
  toggleSidebar: { key: 'b', mods: ['command'], label: 'sidebar' },
};

async function desktopShortcut(action) {
  const spec = DESKTOP_ACTIONS[action];
  if (!spec) {
    const err = new Error(`unknown desktop action: ${action}`);
    err.code = 'UNKNOWN_ACTION';
    throw err;
  }
  await keystroke(spec.key, spec.mods);
  return { ok: true, action, label: spec.label };
}

async function pasteText(text) {
  const escaped = String(text)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  await ensureCodexFocused();
  await osa(`set the clipboard to "${escaped}"`);
  await delay(80);
  return sendKey('v', ['command']);
}

/**
 * Focus Codex composer, paste text, press Return.
 * Avoids relying on ⌘K when the field may already be focused; still tries ⌘K once.
 */
async function submitToCodex(text) {
  const body = String(text || '').trim();
  if (!body) return false;
  await ensureCodexFocused();
  await delay(120);
  try {
    await sendKey('k', ['command']);
  } catch {
    /* composer shortcut may vary */
  }
  await delay(140);
  const escaped = body
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  await osa(`set the clipboard to "${escaped}"`);
  await delay(60);
  await sendKey('v', ['command']);
  await delay(100);
  await sendKey('return');
  return true;
}

/**
 * Speak into the focused app via macOS dictation (usually Ghostty CLI pane).
 * Prefer focusing a CLI slot first — see beginVoiceDictation in the bridge.
 * Does NOT send ⌘K (Cursor palette).
 * @param {{ slot?: number, alreadyFocused?: boolean }} [opts]
 */
async function beginCodexDictation(opts = {}) {
  const slot = Number.isFinite(Number(opts.slot)) ? Math.max(0, Math.min(5, Number(opts.slot))) : null;

  if (!opts.alreadyFocused && slot != null) {
    let f = await focusCodexCliWindow(slot, { fast: true, activate: true });
    if (!f.ok) f = await focusCodexCliWindow(slot, { fast: false, activate: true });
    if (!f.ok) {
      const err = new Error(`Agent ${slot + 1} CLI 창을 먼저 여세요`);
      err.code = 'NO_CLI';
      throw err;
    }
  }

  await delay(140);
  const front = await frontmostAppName();

  try {
    await osa(`
      tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
        try
          click menu item "Start Dictation" of menu "Edit" of menu bar 1 of process frontApp
        on error
          try
            click menu item "받아쓰기 시작" of menu "편집" of menu bar 1 of process frontApp
          on error
            key code 63
            delay 0.08
            key code 63
          end try
        end try
      end tell
    `);
  } catch {
    try {
      await osa('tell application "System Events" to key code 63');
      await delay(80);
      await osa('tell application "System Events" to key code 63');
    } catch {
      /* user can enable dictation manually */
    }
  }
  return { ok: true, app: front || '', slot };
}

/**
 * Submit whatever is in the frontmost composer (CLI / Codex).
 * @param {{ slot?: number, focusDesktop?: boolean }} [opts]
 */
async function submitCodexComposer(opts = {}) {
  const slot = Number.isFinite(Number(opts.slot)) ? Math.max(0, Math.min(5, Number(opts.slot))) : null;
  if (opts.focusDesktop) {
    await ensureCodexFocused();
  } else if (slot != null) {
    let f = await focusCodexCliWindow(slot, { fast: true, activate: true });
    if (!f.ok) f = await focusCodexCliWindow(slot, { fast: false, activate: true });
  }
  await delay(80);
  await sendKey('return');
  return true;
}

function cliWindowTitle(slot) {
  return `Codex · Agent ${Math.max(0, Math.min(5, Number(slot) || 0)) + 1}`;
}

function asEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Shell line: set tab title then run Codex */
function cliLaunchLine(title, command) {
  const t = String(title).replace(/'/g, `'\\''`);
  return `printf '\\033]0;${t}\\007'; ${command}`;
}

/**
 * macOS default terminal for unix executables (Ghostty / Terminal / iTerm…).
 * Cached — Launch Services lookup is slow if called every poll.
 */
function getDefaultTerminalApp() {
  if (cachedDefaultTerminal && Date.now() - cachedDefaultTerminalAt < 60_000) {
    return Promise.resolve(cachedDefaultTerminal);
  }
  return new Promise((resolve) => {
    execFile(
      'swift',
      [
        '-e',
        'import AppKit; let u = NSWorkspace.shared.urlForApplication(toOpen: URL(fileURLWithPath: "/bin/zsh")); print(u?.path ?? "")',
      ],
      { timeout: 5000 },
      (err, stdout) => {
        const p = String(stdout || '').trim();
        let result;
        if (err || !p) {
          result = { path: '/Applications/Ghostty.app', name: 'Ghostty', id: 'com.mitchellh.ghostty' };
        } else {
          const name = path.basename(p, '.app') || 'Ghostty';
          let id = '';
          try {
            id = String(
              require('child_process').execFileSync(
                'mdls',
                ['-name', 'kMDItemCFBundleIdentifier', '-raw', p],
                { encoding: 'utf8', timeout: 3000 }
              )
            ).trim();
          } catch {
            /* ignore */
          }
          result = { path: p, name, id };
        }
        cachedDefaultTerminal = result;
        cachedDefaultTerminalAt = Date.now();
        resolve(result);
      }
    );
  });
}

function terminalKind(app) {
  const n = String(app?.name || '').toLowerCase();
  const id = String(app?.id || '').toLowerCase();
  if (n.includes('ghostty') || id.includes('ghostty')) return 'ghostty';
  if (n.includes('iterm') || id.includes('iterm')) return 'iterm';
  if (n.includes('terminal') || id.includes('terminal')) return 'terminal';
  return 'ghostty'; // prefer Ghostty-style scripting; .command fallback below
}

function looksLikeTerminalFrontmost(frontName, termApp) {
  const f = String(frontName || '').toLowerCase();
  if (!f) return false;
  // Never treat Agent Micro / Electron pad as the CLI terminal
  if (f.includes('electron') || f.includes('agent micro')) return false;
  const n = String(termApp?.name || '').toLowerCase();
  if (n && f.includes(n)) return true;
  if (f.includes('ghostty')) return true;
  if (f.includes('iterm')) return true;
  if (f === 'terminal' || /(^| )terminal( |$)/.test(f)) return true;
  return false;
}

/**
 * True when frontmost app is the default terminal AND this pad opened a Codex CLI there.
 * (Title matching is unreliable — we track opens from Agent Micro.)
 */
async function isOurCliFrontmost() {
  if (process.platform !== 'darwin') return false;
  if (!hasOurCliSession()) return false;
  try {
    const front = await frontmostAppName();
    const term = await getDefaultTerminalApp();
    if (!looksLikeTerminalFrontmost(front, term)) return false;

    // Prefer: focused Ghostty terminal id is one we created
    if (ourCliTerminalIds.size > 0 && terminalKind(term) === 'ghostty') {
      try {
        const appName = asEscape(term.name || 'Ghostty');
        const tid = await osa(`
          tell application "${appName}"
            try
              return id of (focused terminal of selected tab of front window) as text
            on error
              return ""
            end try
          end tell
        `);
        if (tid && ourCliTerminalIds.has(String(tid).trim())) return true;
        // Id unknown/changed but we still own a CLI session in this terminal app
      } catch {
        /* fall through */
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** @deprecated use isOurCliFrontmost */
async function isCodexCliTerminalFrontmost() {
  return isOurCliFrontmost();
}

/** Open via .command so Launch Services uses the OS default terminal. */
function openInDefaultTerminal(title, command) {
  const os = require('os');
  const fs = require('fs');
  const dir = path.join(os.tmpdir(), 'agent-micro-cli');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(title).replace(/[^\w.-]+/g, '_');
  const file = path.join(dir, `${safe}-${Date.now()}.command`);
  const body = `#!/bin/zsh\nprintf '\\033]0;${String(title).replace(/'/g, `'\\''`)}\\007'\n${command}\nexec zsh\n`;
  fs.writeFileSync(file, body, { mode: 0o755 });
  return new Promise((resolve, reject) => {
    execFile('open', [file], (err) => (err ? reject(err) : resolve({ ok: true, file })));
  });
}

/**
 * Which agent slots already have a CLI window/tab in the default terminal app.
 * Ghostty: scan top-level `terminals` (works even when app is not frontmost).
 */
/** Live Ghostty terminal ids (Ghostty `name` is cwd/process — not OSC title). */
async function listGhosttyTerminalIds(appName) {
  const name = asEscape(appName || 'Ghostty');
  try {
    const out = await osa(
      `
      tell application "${name}"
        set ids to {}
        repeat with term in terminals
          try
            set end of ids to (id of term as text)
          end try
        end repeat
        set AppleScript's text item delimiters to ","
        set s to ids as text
        set AppleScript's text item delimiters to ""
        return s
      end tell`,
      { timeout: 1800 }
    );
    return new Set(
      String(out || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

function forgetOpenedSlotSilent(slot) {
  const i = Math.max(0, Math.min(5, Number(slot) || 0));
  const tid = slotTerminalIds.get(i);
  openedCliSlots.delete(i);
  slotTerminalIds.delete(i);
  if (tid) ourCliTerminalIds.delete(tid);
}

/**
 * Drop slots whose Ghostty terminal id is gone, then keep only a contiguous
 * 0…N-1 prefix (so a hole never lets Agent 5 look "open" without 3/4).
 */
function pruneStaleCliSession(liveIds) {
  hydrateCliSession();
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds || []);
  let changed = false;
  for (const [slot, tid] of [...slotTerminalIds.entries()]) {
    if (!tid || !live.has(tid)) {
      forgetOpenedSlotSilent(slot);
      changed = true;
    }
  }
  for (const slot of [...openedCliSlots]) {
    if (!slotTerminalIds.has(slot)) {
      openedCliSlots.delete(slot);
      changed = true;
    }
  }
  // Contiguous from Agent 1 only
  const open = [...slotTerminalIds.keys()].sort((a, b) => a - b);
  let prefix = 0;
  while (prefix < open.length && open[prefix] === prefix) prefix += 1;
  for (const s of open) {
    if (s >= prefix) {
      forgetOpenedSlotSilent(s);
      changed = true;
    }
  }
  if (openedCliSlots.size === 0 && ourCliTerminalIds.size === 0) {
    ourCliSessionActive = false;
  }
  if (changed) persistCliSession();
}

async function listOpenCodexCliSlots() {
  if (process.platform !== 'darwin') return [];
  const app = cachedDefaultTerminal || (await getDefaultTerminalApp());
  const kind = terminalKind(app);
  const appName = asEscape(app.name || 'Ghostty');

  try {
    // Ghostty: track by terminal id (title matching is unreliable)
    if (kind === 'ghostty') {
      const liveIds = await listGhosttyTerminalIds(app.name || 'Ghostty');
      pruneStaleCliSession(liveIds);
      return [...slotTerminalIds.keys()]
        .filter((s) => liveIds.has(slotTerminalIds.get(s)))
        .sort((a, b) => a - b);
    }

    // Terminal.app: custom title / window name contains "Codex · Agent N"
    const script = `
      tell application "${appName}"
        set found to {}
        repeat with n from 1 to 6
          set targetTitle to "Codex · Agent " & n
          set hit to false
          repeat with w in windows
            try
              set wn to name of w as text
              if wn contains targetTitle then set hit to true
            end try
            try
              repeat with t in tabs of w
                try
                  if (custom title of t as text) is targetTitle then set hit to true
                  if (name of t as text) contains targetTitle then set hit to true
                end try
              end repeat
            end try
          end repeat
          if hit then set end of found to n
        end repeat
        set AppleScript's text item delimiters to ","
        set s to found as text
        set AppleScript's text item delimiters to ""
        return s
      end tell`;
    const out = await osa(script, { timeout: 1800 });
    if (!out) return [];
    const slots = String(out)
      .split(',')
      .map((x) => Number(String(x).trim()) - 1)
      .filter((i) => i >= 0 && i <= 5);
    for (const s of slots) rememberOpenedSlot(s, null, { persist: false, allowWithoutId: true });
    if (slots.length) persistCliSession();
    return [...new Set(slots)].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Open slots with a known terminal id (after hydrate; may still be stale until prune). */
function rememberedOpenSlots() {
  hydrateCliSession();
  return [...slotTerminalIds.keys()].sort((a, b) => a - b);
}

async function hasCodexCliWindow(slot) {
  const open = await listOpenCodexCliSlots();
  return open.includes(Math.max(0, Math.min(5, Number(slot) || 0)));
}

async function focusCodexCliWindow(slot, opts = {}) {
  if (process.platform !== 'darwin') return { ok: false };
  const fast = opts.fast !== false;
  const doActivate = opts.activate !== false;
  const app = cachedDefaultTerminal || (await getDefaultTerminalApp());
  const kind = terminalKind(app);
  const appName = asEscape(app.name || 'Ghostty');
  const index = Math.max(0, Math.min(5, Number(slot) || 0));
  const title = cliWindowTitle(index);
  const asTitle = asEscape(title);
  const knownId = slotTerminalIds.get(index);
  const activateLine = doActivate ? 'activate' : '';

  try {
    // Ghostty: top-level `terminals` + known id → one short loop
    if (kind === 'ghostty' && knownId) {
      const out = await osa(
        `
        tell application "${appName}"
          ${activateLine}
          set targetId to "${asEscape(String(knownId))}"
          repeat with term in terminals
            try
              if (id of term as text) is targetId then
                focus term
                return "focused"
              end if
            end try
          end repeat
          return "missing"
        end tell`,
        { timeout: 2500 }
      );
      if (out === 'focused') return { ok: true };
      if (fast) return { ok: false, error: 'missing' };
    }

    let script;
    if (kind === 'ghostty') {
      script = `
        tell application "${appName}"
          ${activateLine}
          set targetTitle to "${asTitle}"
          repeat with term in terminals
            try
              if (name of term as text) contains targetTitle then
                focus term
                return "focused"
              end if
            end try
          end repeat
          return "missing"
        end tell`;
    } else {
      script = `
        tell application "${appName}"
          set targetTitle to "${asTitle}"
          repeat with w in windows
            try
              repeat with t in tabs of w
                try
                  if (custom title of t as text) is targetTitle or (name of t as text) contains targetTitle then
                    set selected of t to true
                    set index of w to 1
                    activate
                    return "focused"
                  end if
                end try
              end repeat
            end try
          end repeat
          return "missing"
        end tell`;
    }
    const out = await osa(script, { timeout: 4000 });
    return { ok: out === 'focused' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Slots / terminal ids we opened from Agent Micro (persisted across restarts) */
const openedCliSlots = new Set();
const ourCliTerminalIds = new Set();
/** @type {Map<number, string>} */
const slotTerminalIds = new Map();
let ourCliSessionActive = false;
let cachedDefaultTerminal = null;
let cachedDefaultTerminalAt = 0;
let cliSessionHydrated = false;

function persistCliSession() {
  try {
    const dir = path.dirname(CLI_SESSION_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const ids = {};
    for (const [k, v] of slotTerminalIds) ids[String(k)] = v;
    fs.writeFileSync(
      CLI_SESSION_PATH,
      JSON.stringify(
        {
          slots: [...openedCliSlots].sort((a, b) => a - b),
          ids,
          at: Date.now(),
        },
        null,
        2
      ),
      'utf8'
    );
  } catch {
    /* ignore */
  }
}

function hydrateCliSession() {
  if (cliSessionHydrated) return;
  cliSessionHydrated = true;
  try {
    if (!fs.existsSync(CLI_SESSION_PATH)) return;
    const data = JSON.parse(fs.readFileSync(CLI_SESSION_PATH, 'utf8'));
    const slots = Array.isArray(data?.slots) ? data.slots : [];
    for (const s of slots) {
      const i = Math.max(0, Math.min(5, Number(s)));
      if (Number.isFinite(i)) openedCliSlots.add(i);
    }
    const ids = data?.ids && typeof data.ids === 'object' ? data.ids : {};
    for (const [k, v] of Object.entries(ids)) {
      const i = Math.max(0, Math.min(5, Number(k)));
      const tid = String(v || '').trim();
      if (!Number.isFinite(i) || !tid) continue;
      slotTerminalIds.set(i, tid);
      ourCliTerminalIds.add(tid);
      openedCliSlots.add(i);
    }
    if (openedCliSlots.size > 0) ourCliSessionActive = true;
  } catch {
    /* ignore corrupt file */
  }
}

function rememberOpenedSlot(slot, terminalId, opts = {}) {
  hydrateCliSession();
  const i = Math.max(0, Math.min(5, Number(slot) || 0));
  const tid =
    terminalId != null && String(terminalId).trim() ? String(terminalId).trim() : '';
  // Id-backed slots are authoritative (Ghostty). allowWithoutId = Terminal.app titles.
  if (tid) {
    ourCliTerminalIds.add(tid);
    slotTerminalIds.set(i, tid);
    openedCliSlots.add(i);
    ourCliSessionActive = true;
  } else if (opts.allowWithoutId) {
    openedCliSlots.add(i);
    ourCliSessionActive = true;
  }
  if (opts.persist !== false) persistCliSession();
}

function forgetOpenedSlot(slot) {
  const i = Math.max(0, Math.min(5, Number(slot) || 0));
  const tid = slotTerminalIds.get(i);
  openedCliSlots.delete(i);
  slotTerminalIds.delete(i);
  if (tid) ourCliTerminalIds.delete(tid);
  if (openedCliSlots.size === 0 && ourCliTerminalIds.size === 0) {
    ourCliSessionActive = false;
  }
  persistCliSession();
}

/** Detected/live slots only — never re-inflate from stale disk memory. */
function mergeOpenSlots(detected) {
  const set = new Set(Array.isArray(detected) ? detected : []);
  return [...set].sort((a, b) => a - b);
}

function hasOurCliSession() {
  hydrateCliSession();
  return ourCliSessionActive || openedCliSlots.size > 0 || ourCliTerminalIds.size > 0;
}

/**
 * Agent 1 = new window · Agent 2–6 = split only inside that window.
 * Must open in order: no Agent N without Agents 1…N-1.
 */
function resolveCliSlot(requested, openSlots) {
  const req = Math.max(0, Math.min(5, Number(requested) || 0));
  const open = Array.isArray(openSlots) ? openSlots : [];

  if (open.includes(req)) {
    return { slot: req, mode: 'focus' };
  }

  // Agent 1 → always a new window (never remap to another slot)
  if (req === 0) {
    return { slot: 0, mode: 'window' };
  }

  // Agent 2–6 require Agent 1's window
  if (!open.includes(0)) {
    return { slot: req, mode: 'blocked', reason: 'need-agent-1' };
  }

  // Sequential: Agent N needs Agents 1…N-1 already open
  for (let i = 1; i < req; i++) {
    if (!open.includes(i)) {
      return { slot: req, mode: 'blocked', reason: `need-agent-${i + 1}` };
    }
  }

  return { slot: req, mode: 'split' };
}

/**
 * Open Codex CLI in the OS default terminal.
 * Agent 1 = new window · Agent 2–6 = ⌘D split in that window only (in order).
 */
async function ensureCodexCliWindow(requestedSlot, opts = {}) {
  const command = String(opts.command || 'codex').trim() || 'codex';

  if (process.platform !== 'darwin') {
    return { ok: false, error: 'CLI windows require macOS' };
  }

  hydrateCliSession();

  const req = Math.max(0, Math.min(5, Number(requestedSlot) || 0));
  const appFast = cachedDefaultTerminal || (await getDefaultTerminalApp());
  const kindFast = terminalKind(appFast);

  // Always reconcile Ghostty ids with live terminals before any open/focus decision
  let open = [];
  if (kindFast === 'ghostty') {
    open = await listOpenCodexCliSlots();
  } else {
    open = mergeOpenSlots(await listOpenCodexCliSlots());
  }

  const blockedResult = (why) => ({
    ok: false,
    slot: req,
    opened: false,
    existed: false,
    focused: false,
    mode: 'blocked',
    reason: why || 'blocked',
    error:
      why === 'need-agent-1'
        ? lt('bridge.needAgent1')
        : /^need-agent-\d+$/.test(String(why || ''))
          ? lt('bridge.needAgentN', { n: String(why).replace('need-agent-', '') })
          : lt('bridge.order'),
  });

  let { slot, mode, reason } = resolveCliSlot(requestedSlot, open);
  if (mode === 'blocked') return blockedResult(reason);

  // Known live slot → focus
  if (mode === 'focus') {
    let f = await focusCodexCliWindow(req, { fast: true, activate: true });
    if (!f.ok) f = await focusCodexCliWindow(req, { fast: false, activate: true });
    if (f.ok) {
      return {
        ok: true,
        slot: req,
        existed: true,
        focused: true,
        opened: false,
        mode: 'focus',
        app: appFast.name,
        fast: true,
      };
    }
    forgetOpenedSlot(req);
    open = mergeOpenSlots(await listOpenCodexCliSlots());
    ({ slot, mode, reason } = resolveCliSlot(requestedSlot, open));
    if (mode === 'blocked') return blockedResult(reason);
  }

  const app = cachedDefaultTerminal || (await getDefaultTerminalApp());
  const kind = terminalKind(app);
  const appName = asEscape(app.name || 'Ghostty');

  // Already open → focus that pane
  if (mode === 'focus') {
    const f = await focusCodexCliWindow(slot, { fast: false, activate: true });
    if (f.ok) {
      return {
        ok: true,
        slot,
        existed: true,
        focused: true,
        opened: false,
        mode,
        app: app.name,
      };
    }
    forgetOpenedSlot(slot);
    // Fall through to open/split with refreshed open set
    open = mergeOpenSlots(await listOpenCodexCliSlots());
    ({ slot, mode, reason } = resolveCliSlot(requestedSlot, open));
    if (mode === 'blocked') return blockedResult(reason);
    if (mode === 'focus') {
      return {
        ok: false,
        slot,
        existed: true,
        focused: false,
        opened: false,
        mode,
        app: app.name,
        error: 'focus failed',
      };
    }
  }

  const title = cliWindowTitle(slot);
  const line = cliLaunchLine(title, command);
  const asLine = asEscape(line);
  // Split from the previous agent pane: 1→2, 2→3, … (not always from Agent 1)
  const hostSlot = mode === 'split' ? Math.max(0, slot - 1) : 0;
  const hostId = slotTerminalIds.get(hostSlot);

  try {
    if (kind === 'ghostty') {
      if (mode === 'window') {
        const tid = await osa(
          `
          tell application "${appName}"
            activate
            set cfg to new surface configuration
            set win to new window with configuration cfg
            delay 0.08
            set term to focused terminal of selected tab of win
            input text "${asLine}" to term
            send key "enter" to term
            try
              return id of term as text
            on error
              return ""
            end try
          end tell
        `,
          { timeout: 4000 }
        );
        if (!String(tid || '').trim()) throw new Error('no terminal id after window open');
        rememberOpenedSlot(slot, tid);
      } else {
        // Split from previous agent (N-1 → N) — host must be the known id (no front-window guess)
        if (!hostId) throw new Error(`no host id for Agent ${hostSlot + 1}`);
        const tid = await osa(
          `
          tell application "${appName}"
            activate
            set hostTerm to missing value
            set targetHostId to "${asEscape(String(hostId))}"
            repeat with term in terminals
              try
                if (id of term as text) is targetHostId then
                  set hostTerm to term
                  exit repeat
                end if
              end try
            end repeat
            if hostTerm is missing value then error "host terminal missing"
            set cfg to new surface configuration
            focus hostTerm
            set term to split hostTerm direction right with configuration cfg
            delay 0.06
            focus term
            input text "${asLine}" to term
            send key "enter" to term
            try
              return id of term as text
            on error
              return ""
            end try
          end tell
        `,
          { timeout: 4000 }
        );
        if (!String(tid || '').trim()) throw new Error('no terminal id after split');
        rememberOpenedSlot(slot, tid);
      }
    } else if (kind === 'terminal') {
      if (mode === 'window') {
        await osa(
          `
          tell application "${appName}"
            activate
            do script "${asEscape(line)}"
            delay 0.12
            try
              set custom title of selected tab of front window to "${asEscape(title)}"
            end try
          end tell
        `,
          { timeout: 4000 }
        );
      } else {
        await osa(
          `
          tell application "${appName}"
            activate
            set hostWin to front window
            do script "${asEscape(line)}" in hostWin
            delay 0.12
            try
              set custom title of selected tab of front window to "${asEscape(title)}"
            end try
          end tell
        `,
          { timeout: 4000 }
        );
      }
      rememberOpenedSlot(slot, null, { allowWithoutId: true });
      if (mode === 'window') rememberOpenedSlot(0, null, { allowWithoutId: true });
    } else if (kind === 'iterm' || mode === 'split') {
      if (mode === 'window') {
        await openInDefaultTerminal(title, command);
        rememberOpenedSlot(slot, null, { allowWithoutId: true });
      } else {
        // Focus previous agent first so ⌘D splits from that pane
        const focused = await focusCodexCliWindow(hostSlot, { fast: true, activate: true });
        if (!focused?.ok) throw new Error(`host Agent ${hostSlot + 1} not focused`);
        await osa(
          `
          tell application "${appName}" to activate
          delay 0.06
          tell application "System Events"
            keystroke "d" using command down
          end tell
          delay 0.12
          tell application "${appName}" to activate
          delay 0.04
          tell application "System Events"
            keystroke "${asLine}"
            key code 36
          end tell
        `,
          { timeout: 4000 }
        );
        rememberOpenedSlot(slot, null, { allowWithoutId: true });
      }
    } else {
      if (mode === 'split') throw new Error('split unsupported for this terminal');
      await openInDefaultTerminal(title, command);
      rememberOpenedSlot(slot, null, { allowWithoutId: true });
    }
    return { ok: true, slot, opened: true, existed: false, focused: true, mode, app: app.name };
  } catch (e) {
    // Never open a random new window to "satisfy" a split — that bypasses 1→6 order
    if (mode === 'split') {
      return {
        ok: false,
        slot,
        error: e.message || String(e),
        mode,
        app: app.name,
      };
    }
    try {
      await openInDefaultTerminal(title, command);
      rememberOpenedSlot(slot, null, { allowWithoutId: true });
      return { ok: true, slot, opened: true, existed: false, focused: true, mode, app: app.name, fallback: true };
    } catch (e2) {
      return { ok: false, slot, error: e2.message || e.message || String(e), mode };
    }
  }
}

module.exports = {
  focusCodexApp,
  ensureCodexFocused,
  frontmostAppName,
  isCodexFrontmost,
  keystroke,
  sendKey,
  desktopShortcut,
  DESKTOP_ACTIONS,
  pasteText,
  submitToCodex,
  beginCodexDictation,
  submitCodexComposer,
  cliWindowTitle,
  getDefaultTerminalApp,
  listOpenCodexCliSlots,
  hasCodexCliWindow,
  focusCodexCliWindow,
  resolveCliSlot,
  ensureCodexCliWindow,
  isCodexCliTerminalFrontmost,
  isOurCliFrontmost,
  hasOurCliSession,
  pruneStaleCliSession,
  listGhosttyTerminalIds,
};

hydrateCliSession();
