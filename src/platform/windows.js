/** Windows platform helpers for Agent Micro.
 * Uses Windows Terminal (or PowerShell) and PowerShell's SendKeys/clipboard.
 * Session/window discovery is intentionally conservative; the CLI remains usable
 * even when another terminal is configured as the default.
 */
const { execFile } = require('child_process');
const openSlots = new Set();

function run(file, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message || '').trim()));
      else resolve(String(stdout || '').trim());
    });
  });
}

function ps(script, timeout) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeout);
}

function esc(value) {
  return String(value).replace(/'/g, "''");
}

async function ensureCodexCliWindow(slot, opts = {}) {
  const command = String(opts.command || 'codex');
  const title = `Agent Micro ${Number(slot) + 1}`;
  const cwd = opts.cwd || process.cwd();
  const script = `$Host.UI.RawUI.WindowTitle='${esc(title)}'; Set-Location -LiteralPath '${esc(cwd)}'; ${command}`;
  try {
    await run('wt.exe', ['-w', '0', 'new-tab', '--title', title, 'powershell.exe', '-NoExit', '-Command', script], 12000);
  } catch {
    await run('powershell.exe', ['-NoProfile', '-Command', `Start-Process powershell.exe -ArgumentList '-NoExit','-Command',\"${script.replace(/"/g, '\\"')}\"`], 12000);
  }
  openSlots.add(Number(slot));
  return { ok: true, slot: Number(slot), opened: true, focused: true, mode: 'window', app: 'Windows Terminal' };
}

async function sendKey(slot, key, mods = []) {
  const names = { enter: '{ENTER}', return: '{ENTER}', escape: '{ESC}', tab: '{TAB}', left: '{LEFT}', right: '{RIGHT}', up: '{UP}', down: '{DOWN}', backspace: '{BACKSPACE}' };
  const token = names[String(key).toLowerCase()] || String(key);
  const prefix = mods.includes('control') ? '^' : mods.includes('shift') ? '+' : mods.includes('alt') || mods.includes('option') ? '%' : '';
  await ps(`$ws=New-Object -ComObject WScript.Shell; $ws.AppActivate('Agent Micro ${Number(slot) + 1}') | Out-Null; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${esc(prefix + token)}')`);
  return { ok: true };
}

async function submitToCli(_slot, text) {
  const body = String(text || '').trim();
  if (!body) return false;
  const encoded = Buffer.from(body, 'utf8').toString('base64');
  const title = `Agent Micro ${Number(_slot) + 1}`;
  await ps(`$ws=New-Object -ComObject WScript.Shell; $ws.AppActivate('${esc(title)}') | Out-Null; $s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); Set-Clipboard -Value $s; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v'); [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')`);
  return true;
}

async function clearCliInput(slot = 0) {
  await ps(`$ws=New-Object -ComObject WScript.Shell; $ws.AppActivate('Agent Micro ${Number(slot) + 1}') | Out-Null; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^a'); [System.Windows.Forms.SendKeys]::SendWait('{BACKSPACE}')`);
  return { ok: true };
}

async function cliApprove(slot = 0) { return sendKey(slot, 'y'); }
async function cliDecline(slot = 0) { return sendKey(slot, 'n'); }
async function cliKeystroke(slot = 0, key, mods = []) { await focusCliSlot(slot); return sendKey(slot, key, mods); }
async function desktopShortcut() { return { ok: false, error: 'Desktop shortcuts are not available on Windows yet' }; }
async function focusCliSlot(slot) { await ps(`$ws=New-Object -ComObject WScript.Shell; $ws.AppActivate('Agent Micro ${Number(slot) + 1}') | Out-Null`); return { ok: true, slot: Number(slot) }; }
async function isOurCliFrontmost() { return openSlots.size > 0; }
async function listOpenCodexCliSlots() { return [...openSlots].sort((a, b) => a - b); }
async function getFocusedCliSlot() { return openSlots.size ? [...openSlots][0] : null; }
async function getCliSlotWorkingDirectory() { return ''; }
async function getCliSlotRolloutPath() { return ''; }
async function triggerDictation() { return { ok: false, error: 'Use Windows Voice Access or dictation' }; }
async function focusCodexApp() { return { ok: false, reason: 'Codex desktop focus is not implemented on Windows' }; }

module.exports = {
  ensureCodexCliWindow, submitToCli, clearCliInput, cliApprove, cliDecline, cliKeystroke, sendKey,
  desktopShortcut, focusCliSlot, isOurCliFrontmost, listOpenCodexCliSlots,
  getFocusedCliSlot, getCliSlotWorkingDirectory, getCliSlotRolloutPath,
  triggerDictation, focusCodexApp,
};
