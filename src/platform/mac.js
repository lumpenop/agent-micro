/**
 * macOS helpers — focus Codex Desktop + inject shortcuts via System Events.
 * Requires Accessibility permission for keystrokes.
 *
 * All pad actions go through this desktop path (not CLI app-server).
 */
const { execFile } = require('child_process');

function osa(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 8000 }, (err, stdout, stderr) => {
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
    const err = new Error(`포커스가 ${front || '?'} · Codex 앱 필요`);
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
 * Speak into already-logged-in Codex via macOS dictation.
 * Does NOT send ⌘K — that opens Cursor's command palette when focus is wrong.
 */
async function beginCodexDictation() {
  const focus = await ensureCodexFocused();
  await delay(120);

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
  return { ok: true, app: focus.app };
}

async function submitCodexComposer() {
  await ensureCodexFocused();
  await delay(80);
  await sendKey('return');
  return true;
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
};
