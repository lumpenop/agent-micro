const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  const { createDialStepper } = await import('../src/dial-controller.mjs');
  const moved = [];
  const dial = createDialStepper({ stepDegrees: 12, onStep: (steps) => moved.push(steps) });
  assert.equal(dial.push(6), 0);
  assert.equal(dial.push(6), 1);
  assert.equal(dial.push(-24), -2);
  assert.deepEqual(moved, [1, -2]);

  const padSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'pad3d.mjs'), 'utf8');
  assert.ok(!/\bdialMoved\b/.test(padSource), 'dial must not throw after visual rotation');

  const mac = require('../src/platform/mac');
  const originalClear = mac.clearCliInput;
  const originalSubmit = mac.submitToCli;
  const originalOpenSlots = mac.listOpenCodexCliSlots;
  const originalCwd = mac.getCliSlotWorkingDirectory;
  let clears = 0;
  let submits = 0;
  mac.clearCliInput = async () => { clears += 1; return { ok: true }; };
  mac.submitToCli = async (_slot, text) => {
    submits += 1;
    assert.equal(text, '/model');
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true };
  };
  try {
    const { CodexBridge } = require('../src/providers/codex-bridge');
    const bridge = new CodexBridge();
    bridge.connected = true;
    bridge.agents[0] = { ...bridge.agents[0], status: 'thinking', threadId: 'thread-test' };
    bridge.ensureAgentCliWindow = async () => ({ ok: true, slot: 0 });
    const [first, second] = await Promise.all([bridge.openModelPicker(), bridge.openModelPicker()]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(clears, 1, 'concurrent picker clicks should share one operation');
    assert.equal(submits, 1, 'concurrent picker clicks should submit /model once');

    mac.listOpenCodexCliSlots = async () => [0];
    mac.getCliSlotWorkingDirectory = async () => null;
    bridge.request = async (method) => {
      assert.equal(method, 'thread/list');
      return { threads: [{ id: 'thread-test', title: 'Live Agent', status: 'idle' }] };
    };
    await bridge.refreshThreads();
    assert.equal(bridge.agents[0].status, 'idle', 'stale thinking state must reconcile from Codex');

    bridge._updateSelectedThreadSettings = async ({ model }) => ({ ok: true, model });
    const changed = await bridge.switchModel('provider-owned/model');
    assert.equal(changed.ok, true);
  } finally {
    mac.clearCliInput = originalClear;
    mac.submitToCli = originalSubmit;
    mac.listOpenCodexCliSlots = originalOpenSlots;
    mac.getCliSlotWorkingDirectory = originalCwd;
  }
  process.stdout.write('dial and model controls: ok\n');
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
