/**
 * macOS helpers — focus Codex Desktop + inject shortcuts via System Events.
 * Requires Accessibility permission for keystrokes.
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

function focusCodexApp() {
  return osa('tell application id "com.openai.codex" to activate').catch(() =>
    osa('tell application "ChatGPT" to activate').catch(() => {})
  );
}

/**
 * @param {string} key - single character or special: "left", "right", "up", "down", "return", "escape", "tab", "[", "]", "\\", "b", "k", "n"
 * @param {Array<'command'|'option'|'shift'|'control'>} mods
 */
async function keystroke(key, mods = []) {
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

  await focusCodexApp();
  await new Promise((r) => setTimeout(r, 120));

  if (specials[key] != null) {
    const code = specials[key];
    return osa(
      `tell application "System Events" to key code ${code}${usingClause}`
    );
  }

  const escaped = String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return osa(`tell application "System Events" to keystroke "${escaped}"${usingClause}`);
}

async function pasteText(text) {
  const escaped = String(text)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  await focusCodexApp();
  await osa(`set the clipboard to "${escaped}"`);
  await new Promise((r) => setTimeout(r, 80));
  return osa('tell application "System Events" to keystroke "v" using {command down}');
}

/** Focus Codex, open composer, paste text, press Return. */
async function submitToCodex(text) {
  const body = String(text || '').trim();
  if (!body) return false;
  await focusCodexApp();
  await new Promise((r) => setTimeout(r, 160));
  try {
    await osa('tell application "System Events" to keystroke "k" using {command down}');
  } catch {
    /* composer shortcut may vary */
  }
  await new Promise((r) => setTimeout(r, 140));
  const escaped = body
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  await osa(`set the clipboard to "${escaped}"`);
  await new Promise((r) => setTimeout(r, 60));
  await osa('tell application "System Events" to keystroke "v" using {command down}');
  await new Promise((r) => setTimeout(r, 100));
  await osa('tell application "System Events" to key code 36'); // return
  return true;
}

module.exports = {
  focusCodexApp,
  keystroke,
  pasteText,
  submitToCodex,
};
