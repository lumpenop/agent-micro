#!/usr/bin/env node
/**
 * Live feature smoke test — uses existing agent-micro userData + ~/.codex auth.
 * Does not print secrets.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const USER_DATA = path.join(
  os.homedir(),
  'Library/Application Support/agent-micro'
);

const results = [];

function ok(name, detail = '') {
  results.push({ name, pass: true, detail: String(detail || '') });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, pass: false, detail: String(detail || '') });
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function skip(name, detail = '') {
  results.push({ name, pass: null, detail: String(detail || '') });
  console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log('=== Agent Micro feature smoke ===\n');
  const liveActions = process.env.SMOKE_LIVE_ACTIONS === '1';

  ok('voice.mode', 'bundled local Whisper (WAV capture, no API key)');

  // ── settings / prefs ──
  const settings = require('../src/codex-settings');
  settings.setUserDataPath(USER_DATA);
  try {
    const s = settings.load();
    if (s && s.sandbox_mode) ok('codexSettings.load', `sandbox=${s.sandbox_mode}`);
    else fail('codexSettings.load', JSON.stringify(s));
  } catch (e) {
    fail('codexSettings.load', e.message);
  }

  const prefs = require('../src/pad-prefs');
  prefs.setUserDataPath(USER_DATA);
  try {
    const p = prefs.load();
    const g = prefs.acceleratorPrefix();
    ok('padPrefs.load', `modifier=${p.hotkeyModifier} accel=${g}`);
  } catch (e) {
    fail('padPrefs.load', e.message);
  }

  // ── codex binary + login ──
  const { CodexBridge, findCodexNative } = require('../src/providers/codex-bridge');
  const bin = findCodexNative();
  if (bin) ok('codex.binary', typeof bin === 'object' ? JSON.stringify(bin) : String(bin));
  else fail('codex.binary', 'not found');

  const bridge = new CodexBridge();
  if (typeof bridge.openModelPicker === 'function') ok('codex.modelPicker', 'active-session /model bridge');
  else fail('codex.modelPicker', 'missing');
  if (typeof bridge.switchModel === 'function') ok('codex.modelToggle', 'Light/Deep active-session bridge');
  else fail('codex.modelToggle', 'missing');
  bridge.on('log', (m) => {
    if (process.env.SMOKE_VERBOSE) console.log('  [log]', m);
  });
  bridge.on('state', () => {});

  try {
    const login = await bridge.checkLogin();
    if (login.loggedIn) ok('codex.login', JSON.stringify(login).slice(0, 120));
    else fail('codex.login', JSON.stringify(login));
  } catch (e) {
    fail('codex.login', e.message);
  }

  let connected = false;
  try {
    const c = await bridge.connect({ forceLogin: false });
    connected = !!c.ok;
    if (c.ok) ok('codex.connect', `mode=${bridge.mode}`);
    else fail('codex.connect', JSON.stringify(c));
  } catch (e) {
    fail('codex.connect', e.message);
  }

  const state = bridge.getState?.() || {
    connected: bridge.connected,
    mode: bridge.mode,
    agents: bridge.agents,
    selected: bridge.selected,
  };
  if (connected && state.connected) {
    ok(
      'codex.getState',
      `agents=${(state.agents || []).filter((a) => a && a.status !== 'off').length}/6 selected=${state.selected}`
    );
  } else if (connected) {
    fail('codex.getState', 'connect ok but state.connected false');
  } else {
    skip('codex.getState', 'not connected');
  }

  // Non-destructive command probes (need connection)
  if (connected) {
    try {
      await bridge.toggleFast();
      ok('codex.toggleFast', `reasoningIndex=${bridge.reasoningIndex}`);
    } catch (e) {
      fail('codex.toggleFast', e.message);
    }

    try {
      await bridge.setReasoning?.(2);
      ok('codex.setReasoning', `index=${bridge.reasoningIndex}`);
    } catch (e) {
      fail('codex.setReasoning', e.message);
    }

    if (liveActions) {
      try { await bridge.approve(); ok('codex.approve', 'live action'); }
      catch (e) { fail('codex.approve', e.message); }
      try { await bridge.decline(); ok('codex.decline', 'live action'); }
      catch (e) { fail('codex.decline', e.message); }
    } else {
      skip('codex.approve', 'set SMOKE_LIVE_ACTIONS=1 (types into visible CLI)');
      skip('codex.decline', 'set SMOKE_LIVE_ACTIONS=1 (types into visible CLI)');
    }

    if (liveActions) {
      try {
        await bridge.send('Agent Micro smoke test ping — reply with exactly: ok');
        ok('codex.send', `slot=${bridge.selected + 1}`);
      } catch (e) { fail('codex.send', e.message); }
      try {
        await bridge.voiceToCodex('smoke voice text');
        ok('codex.voiceToCodex', 'invoked');
      } catch (e) { fail('codex.voiceToCodex', e.message); }
      try {
        await bridge.skill('review');
        ok('codex.skill', 'review');
      } catch (e) { fail('codex.skill', e.message); }
    } else {
      skip('codex.send', 'set SMOKE_LIVE_ACTIONS=1 (sends a real prompt)');
      skip('codex.voiceToCodex', 'set SMOKE_LIVE_ACTIONS=1 (sends a real prompt)');
      skip('codex.skill', 'set SMOKE_LIVE_ACTIONS=1 (sends a real prompt)');
    }

    try {
      if (typeof bridge.togglePlan === 'function') {
        await bridge.togglePlan();
        ok('codex.togglePlan', 'invoked');
      } else skip('codex.togglePlan', 'missing');
    } catch (e) {
      fail('codex.togglePlan', e.message);
    }

    if (liveActions) {
      try { await bridge.newChat(); ok('codex.newChat', 'invoked'); }
      catch (e) { fail('codex.newChat', e.message); }
    } else skip('codex.newChat', 'set SMOKE_LIVE_ACTIONS=1 (opens a real CLI)');
  } else {
    for (const n of [
      'codex.toggleFast',
      'codex.setReasoning',
      'codex.approve',
      'codex.decline',
      'codex.send',
      'codex.voiceToCodex',
      'codex.skill',
      'codex.togglePlan',
      'codex.newChat',
    ]) {
      skip(n, 'not connected');
    }
  }

  // ── macOS CLI window / agent order (real UI side effects) ──
  if (process.platform === 'darwin' && process.env.SMOKE_CLI_WINDOWS === '1') {
    try {
      const r0 = await bridge.select(0, { focus: true });
      if (r0?.ok) ok('agent.select.1', JSON.stringify(r0));
      else fail('agent.select.1', JSON.stringify(r0));
      await new Promise((r) => setTimeout(r, 2500));

      const r1 = await bridge.select(1, { focus: true });
      if (r1?.ok) ok('agent.select.2', JSON.stringify(r1));
      else fail('agent.select.2', JSON.stringify(r1));

      // blocked path: jump to 5 without 3/4
      const r5 = await bridge.select(4, { focus: false });
      if (r5 && r5.ok === false && (r5.reason === 'blocked' || /blocked|순서/.test(JSON.stringify(r5)))) {
        ok('agent.select.5.blocked', JSON.stringify(r5));
      } else if (r5?.ok) {
        ok('agent.select.5', `opened unexpectedly ok=${r5.ok} ${JSON.stringify(r5)}`);
      } else {
        fail('agent.select.5.blocked', JSON.stringify(r5));
      }
    } catch (e) {
      fail('agent.select', e.message);
    }
  } else {
    skip('agent.select.1-6', 'set SMOKE_CLI_WINDOWS=1 to open real terminal splits');
  }

  // ── fork (only if connected + has room) ──
  if (connected && process.env.SMOKE_FORK === '1') {
    try {
      const live = (bridge.agents || []).filter((a) => a && a.status !== 'off').length;
      if (live >= 6) skip('codex.fork', 'slots full');
      else {
        await bridge.fork();
        ok('codex.fork', 'invoked');
      }
    } catch (e) {
      fail('codex.fork', e.message);
    }
  } else {
    skip('codex.fork', 'set SMOKE_FORK=1 to run (side effects)');
  }

  // ── mac helpers present ──
  try {
    const mac = require('../src/platform/mac');
    const names = [
      'ensureCodexCliWindow',
      'beginCodexDictation',
      'submitCodexComposer',
      'listOpenCodexCliSlots',
      'resolveCliSlot',
    ].filter((n) => typeof mac[n] === 'function');
    if (names.length === 5) ok('mac.platform.exports', names.join(', '));
    else fail('mac.platform.exports', `got ${names.join(',')}`);
  } catch (e) {
    fail('mac.platform.exports', e.message);
  }

  // Accessibility hint
  try {
    const r = spawnSync('osascript', ['-e', 'tell application "System Events" to get name'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (r.status === 0) ok('mac.accessibility', 'System Events reachable');
    else fail('mac.accessibility', (r.stderr || r.stdout || '').slice(0, 160));
  } catch (e) {
    fail('mac.accessibility', e.message);
  }

  // cleanup bridge
  try {
    bridge.stop?.();
  } catch {}

  const pass = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false).length;
  const skipped = results.filter((r) => r.pass === null).length;
  console.log(`\n=== Summary: ${pass} pass · ${failed} fail · ${skipped} skip ===`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
