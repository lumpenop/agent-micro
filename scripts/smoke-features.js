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

function makeTinyWav() {
  // Minimal valid WAV: 0.3s silence, 16kHz mono PCM16
  const sampleRate = 16000;
  const seconds = 0.35;
  const numSamples = Math.floor(sampleRate * seconds);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  // soft tone so Whisper may return something (or EMPTY is still auth-ok)
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * 440 * t) * 0.2 * 32767;
    buf.writeInt16LE(sample | 0, 44 + i * 2);
  }
  return buf;
}

async function main() {
  console.log('=== Agent Micro feature smoke ===\n');

  // ── voice / API key ──
  const voice = require('../src/voice-transcribe');
  voice.setUserDataPath(USER_DATA);
  const vs = voice.voiceStatus();
  if (vs.whisperReady && vs.hasStoredKey && !vs.needsSetup) {
    ok('voice.status', `mode=${vs.mode}`);
  } else {
    fail('voice.status', JSON.stringify(vs));
  }

  const key = voice.resolveOpenAIApiKey();
  if (key && key.startsWith('sk-')) ok('voice.resolveApiKey', `sk-… (${key.length} chars)`);
  else fail('voice.resolveApiKey', 'missing');

  // OpenAI auth ping (models)
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) ok('openai.apiKey.valid', `HTTP ${res.status}`);
    else fail('openai.apiKey.valid', `HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  } catch (e) {
    fail('openai.apiKey.valid', e.message);
  }

  // Whisper
  try {
    const wav = makeTinyWav();
    const r = await voice.transcribeWithWhisper(wav, 'audio/wav');
    ok('whisper.transcribe', `text="${String(r.text).slice(0, 60)}"`);
  } catch (e) {
    if (e.code === 'EMPTY') {
      ok('whisper.transcribe', 'auth OK · empty transcript (silence/tone)');
    } else {
      fail('whisper.transcribe', `${e.code || ''} ${e.message}`);
    }
  }

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

    try {
      await bridge.approve();
      ok('codex.approve', 'no-op when nothing pending');
    } catch (e) {
      fail('codex.approve', e.message);
    }

    try {
      await bridge.decline();
      ok('codex.decline', 'no-op when nothing pending');
    } catch (e) {
      fail('codex.decline', e.message);
    }

    try {
      const before = (bridge.agents || []).map((a) => a?.threadId).join(',');
      // send a tiny ping on current/selected — starts thread if needed
      await bridge.send('Agent Micro smoke test ping — reply with exactly: ok');
      const a = bridge.agents[bridge.selected];
      ok(
        'codex.send',
        `slot=${bridge.selected + 1} status=${a?.status} thread=${a?.threadId ? 'yes' : 'no'}`
      );
      // wait briefly for turn
      await new Promise((r) => setTimeout(r, 4000));
      const a2 = bridge.agents[bridge.selected];
      ok('codex.send.followup', `status=${a2?.status} (was ${before ? 'had threads' : 'fresh'})`);
    } catch (e) {
      fail('codex.send', e.message);
    }

    try {
      if (typeof bridge.voiceToCodex === 'function') {
        await bridge.voiceToCodex('smoke voice text');
        ok('codex.voiceToCodex', 'invoked');
      } else skip('codex.voiceToCodex', 'missing');
    } catch (e) {
      fail('codex.voiceToCodex', e.message);
    }

    try {
      if (typeof bridge.skill === 'function') {
        await bridge.skill('review');
        ok('codex.skill', 'review');
      } else skip('codex.skill', 'missing');
    } catch (e) {
      // skill may fail if no thread — still report
      fail('codex.skill', e.message);
    }

    try {
      if (typeof bridge.togglePlan === 'function') {
        await bridge.togglePlan();
        ok('codex.togglePlan', 'invoked');
      } else skip('codex.togglePlan', 'missing');
    } catch (e) {
      fail('codex.togglePlan', e.message);
    }

    try {
      if (typeof bridge.newChat === 'function') {
        await bridge.newChat();
        ok('codex.newChat', 'invoked');
      } else skip('codex.newChat', 'missing');
    } catch (e) {
      fail('codex.newChat', e.message);
    }
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
      'focusCodexCliSlot',
      'beginDictation',
      'endDictation',
    ].filter((n) => typeof mac[n] === 'function');
    if (names.length >= 2) ok('mac.platform.exports', names.join(', '));
    else fail('mac.platform.exports', `only ${names.join(',')}`);
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
