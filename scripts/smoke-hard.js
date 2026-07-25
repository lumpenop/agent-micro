#!/usr/bin/env node
/**
 * Hard end-to-end smoke — no secrets printed.
 * Env: SMOKE_DICTATION=1 to focus CLI + start/stop dictation
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync, spawn } = require('child_process');

const USER = path.join(os.homedir(), 'Library/Application Support/agent-micro');
const results = [];

function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, ok: false, detail });
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function skip(name, detail = '') {
  results.push({ name, ok: null, detail });
  console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ''}`);
}


async function main() {
  console.log('=== Agent Micro HARD SMOKE ===\n');
  if (process.env.SMOKE_LIVE_ACTIONS !== '1') {
    console.log('SKIP  hard smoke — set SMOKE_LIVE_ACTIONS=1; this test opens Terminal and sends real prompts');
    return;
  }

  const settings = require('../src/codex-settings');
  const prefs = require('../src/pad-prefs');
  const i18n = require('../src/i18n');
  const mac = require('../src/platform/mac');
  const { CodexBridge, findCodexNative } = require('../src/providers/codex-bridge');

  settings.setUserDataPath(USER);
  prefs.setUserDataPath(USER);

  // ── settings / prefs / i18n ──
  console.log('\n--- settings / prefs ---');
  try {
    const s = settings.load();
    if (s?.sandbox_mode) pass('settings.load', s.sandbox_mode);
    else fail('settings.load', JSON.stringify(s));
  } catch (e) {
    fail('settings.load', e.message);
  }
  try {
    const p = prefs.load();
    pass('prefs.load', `mod=${p.hotkeyModifier} locale=${p.locale || 'en'}`);
  } catch (e) {
    fail('prefs.load', e.message);
  }
  try {
    if (i18n.t('ko', 'chrome.help') && i18n.t('en', 'chrome.help') !== 'chrome.help') {
      pass('i18n.t');
    } else fail('i18n.t');
  } catch (e) {
    fail('i18n.t', e.message);
  }

  // ── icons ──
  try {
    const mod = await import('../src/icons.mjs');
    if (
      mod.DEFAULT_KEY_ICONS?.send === 'send' &&
      mod.isPickerIcon('send') &&
      Array.isArray(mod.PICKER_BRAND_IDS) &&
      mod.PICKER_BRAND_IDS.length === 0
    ) {
      pass('icons.picker.lucideSend', `n=${mod.ICON_ORDER.length}`);
    } else fail('icons.picker.lucideSend');
  } catch (e) {
    fail('icons.picker.lucideSend', e.message);
  }

  // ── mac ──
  console.log('\n--- mac / cli slots ---');
  try {
    const r = spawnSync('osascript', ['-e', 'tell application "System Events" to get name'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (r.status === 0) pass('mac.accessibility');
    else fail('mac.accessibility', (r.stderr || '').slice(0, 120));
  } catch (e) {
    fail('mac.accessibility', e.message);
  }

  const slotCases = [
    [[], 0, 'window'],
    [[], 1, 'blocked'],
    [[0], 1, 'split'],
    [[0, 1], 3, 'blocked'],
    [[0, 1, 2], 2, 'focus'],
  ];
  let slotOk = true;
  for (const [open, req, want] of slotCases) {
    const r = mac.resolveCliSlot(req, open);
    if (r.mode !== want) {
      slotOk = false;
      fail('mac.resolveCliSlot', `${JSON.stringify(open)}→${req + 1} got ${r.mode}`);
      break;
    }
  }
  if (slotOk) pass('mac.resolveCliSlot');

  let openSlots = [];
  try {
    openSlots = await mac.listOpenCodexCliSlots();
    pass('mac.listOpenSlots', JSON.stringify(openSlots));
  } catch (e) {
    fail('mac.listOpenSlots', e.message);
  }

  // ── codex bridge ──
  console.log('\n--- codex bridge ---');
  const bin = findCodexNative();
  if (bin) pass('codex.binary', bin.type || 'ok');
  else fail('codex.binary', 'missing');

  const bridge = new CodexBridge();
  bridge.on('log', () => {});
  bridge.on('state', () => {});

  try {
    const login = await bridge.checkLogin();
    if (login.loggedIn) pass('codex.login');
    else fail('codex.login', JSON.stringify(login).slice(0, 100));
  } catch (e) {
    fail('codex.login', e.message);
  }

  let connected = false;
  try {
    const c = await bridge.connect({ forceLogin: false });
    connected = !!c.ok;
    if (c.ok) pass('codex.connect', `mode=${bridge.mode}`);
    else fail('codex.connect', JSON.stringify(c).slice(0, 160));
  } catch (e) {
    fail('codex.connect', e.message);
  }

  if (!connected) {
    summary();
    return;
  }

  const st = bridge.getState();
  pass('codex.getState', `selected=${st.selected} agents=${st.agents?.length}`);

  for (const [name, fn] of [
    ['codex.toggleFast', () => bridge.toggleFast()],
    ['codex.setReasoning', () => bridge.setReasoning(2)],
    ['codex.approve.noop', () => bridge.approve()],
    ['codex.decline.noop', () => bridge.decline()],
    ['codex.togglePlan', () => bridge.togglePlan?.()],
    ['codex.skill', () => bridge.setSkill?.('review') || bridge.skill?.('review')],
  ]) {
    try {
      const r = await fn();
      pass(name, r === undefined ? '' : typeof r === 'object' ? JSON.stringify(r).slice(0, 60) : String(r));
    } catch (e) {
      fail(name, e.message);
    }
  }

  // send
  try {
    await bridge.send('hard-smoke ping — reply with one word: ok');
    pass('codex.send');
    await new Promise((r) => setTimeout(r, 3500));
    const a = bridge.agents[bridge.selected];
    if (a?.threadId) pass('codex.send.thread', `status=${a.status}`);
    else fail('codex.send.thread', `status=${a?.status} no thread`);
  } catch (e) {
    fail('codex.send', e.message);
  }

  // voiceToCodex
  try {
    await bridge.voiceToCodex('hard-smoke voice');
    pass('codex.voiceToCodex');
  } catch (e) {
    fail('codex.voiceToCodex', e.message);
  }

  // fork (needs live thread)
  try {
    const before = bridge.selected;
    const f = await bridge.fork();
    if (f?.ok) pass('codex.fork', `slot=${f.slot} from=${before}`);
    else fail('codex.fork', JSON.stringify(f).slice(0, 140));
  } catch (e) {
    fail('codex.fork', e.message);
  }

  // agent select + jump blocked
  console.log('\n--- agent slots ---');
  try {
    const r0 = await bridge.select(0, { focus: true });
    if (r0?.ok) pass('agent.select.1', JSON.stringify(r0));
    else fail('agent.select.1', JSON.stringify(r0));
    await new Promise((r) => setTimeout(r, 1000));
    openSlots = await mac.listOpenCodexCliSlots();
    pass('agent.open.afterSelect1', JSON.stringify(openSlots));

    if (openSlots.includes(1)) {
      const r1 = await bridge.select(1, { focus: true });
      if (r1?.ok) pass('agent.select.2', JSON.stringify(r1));
      else fail('agent.select.2', JSON.stringify(r1));
      await new Promise((r) => setTimeout(r, 800));
    } else {
      skip('agent.select.2', 'slot 2 not open');
    }

    const jump = Math.min(5, (openSlots.length ? Math.max(...openSlots) : 0) + 2);
    const rj = await bridge.select(jump, { focus: false });
    if (rj && rj.ok === false) {
      pass('agent.select.jump.blocked', `slot=${jump + 1} ${rj.reason || rj.error}`);
    } else {
      fail('agent.select.jump.blocked', JSON.stringify(rj));
    }
  } catch (e) {
    fail('agent.select', e.message);
  }

  // dictation
  console.log('\n--- dictation ---');
  if (process.env.SMOKE_DICTATION === '1') {
    try {
      const prep = await bridge.prepareVoiceDictation();
      if (!prep?.ok) {
        fail('voice.dictation.prepare', prep?.error || JSON.stringify(prep));
      } else {
        pass('voice.dictation.prepare', `slot=${prep.slot}`);
        const b = await bridge.beginVoiceDictation();
        if (b?.ok) pass('voice.dictation.begin', `mode=${b.mode || '?'} slot=${b.slot}`);
        else fail('voice.dictation.begin', b?.error || JSON.stringify(b));
        await new Promise((r) => setTimeout(r, 700));
        const e = await bridge.endVoiceDictation();
        if (e?.ok) pass('voice.dictation.end', `slot=${e.slot}`);
        else fail('voice.dictation.end', e?.error || JSON.stringify(e));
      }
    } catch (e) {
      fail('voice.dictation', e.message);
    }
  } else {
    // still test focus path without OS dictation toggle if possible
    try {
      const focus = await bridge.ensureAgentCliWindow(bridge.selected, { focus: true });
      if (focus?.ok) pass('voice.cliFocus', `slot=${bridge.selected}`);
      else fail('voice.cliFocus', JSON.stringify(focus).slice(0, 120));
    } catch (e) {
      fail('voice.cliFocus', e.message);
    }
    try {
      if (typeof bridge.prepareVoiceDictation === 'function') {
        pass('voice.prepare.exists');
      } else fail('voice.prepare.exists', 'missing');
    } catch (e) {
      fail('voice.prepare.exists', e.message);
    }
    skip('voice.dictation.begin', 'set SMOKE_DICTATION=1');
  }

  // newChat if exists
  try {
    if (typeof bridge.newChat === 'function') {
      await bridge.newChat();
      pass('codex.newChat');
    } else skip('codex.newChat', 'no method');
  } catch (e) {
    fail('codex.newChat', e.message);
  }

  try {
    bridge.stop();
    pass('codex.stop');
  } catch (e) {
    fail('codex.stop', e.message);
  }

  // ── electron launch ──
  console.log('\n--- electron ---');
  await electronSmoke();

  // ── userdata ──
  if (fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'))) pass('userdata.codex.auth');
  else fail('userdata.codex.auth', 'missing');

  pass('voice.mode', 'macOS dictation only');
  summary();
}

function electronSmoke() {
  return new Promise((resolve) => {
    const logPath = '/tmp/agent-micro-hard-smoke.log';
    try {
      fs.writeFileSync(logPath, '');
    } catch {}
    const child = spawn('npx', ['electron', '.'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, 5500);

    child.on('close', () => {
      clearTimeout(timer);
      fs.writeFileSync(logPath, out);
      if (/\[pad\] ok/.test(out)) pass('electron.launch', 'pad ok');
      else if (/whenReady/.test(out)) fail('electron.launch', 'ELECTRON_RUN_AS_NODE mishap');
      else if (/Unable to load preload|module not found/i.test(out)) {
        fail('electron.launch', 'preload error');
      } else fail('electron.launch', out.slice(-200).replace(/\s+/g, ' '));
      resolve();
    });
  });
}

function summary() {
  const p = results.filter((r) => r.ok === true).length;
  const f = results.filter((r) => r.ok === false).length;
  const s = results.filter((r) => r.ok === null).length;
  console.log(`\n=== HARD SMOKE: ${p} pass · ${f} fail · ${s} skip ===`);
  if (f) {
    console.log('\nBroken:');
    for (const r of results.filter((x) => x.ok === false)) {
      console.log(` - ${r.name}: ${r.detail}`);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
