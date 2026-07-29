const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-micro-rules-test-'));
const settingsModule = require('../src/codex-settings');
const agentRules = require('../src/agent-rules');

try {
  fs.writeFileSync(path.join(temporary, 'package.json'), '{"name":"rules-test"}\n');
  const saved = agentRules.saveProject(temporary, 'Project rule');
  assert.equal(saved.ok, true);

  const slots = settingsModule.defaultAgentSlots();
  slots[2] = {
    ...slots[2],
    name: 'Reviewer',
    role_id: 'reviewer',
    rules: 'Slot rule',
    preferred_skills: ['review'],
    allowed_tools: ['Read', 'Bash(git *)'],
    model: 'gpt-test',
    model_reasoning_effort: 'high',
    working_directory: temporary,
    sandbox_mode: 'read-only',
    approval_policy: 'untrusted',
    auto_continue: 'on',
  };
  const settings = settingsModule.normalize({
    working_directory: temporary,
    global_agent_rules: 'Global rule',
    agent_slots: slots,
    agent_roles: [{
      id: 'reviewer', name: 'reviewer', description: 'Review work',
      developer_instructions: 'Role rule', model: '', model_reasoning_effort: '', enabled: true,
    }],
  });
  const resolved = agentRules.resolve(settings, 2);
  for (const text of ['Global rule', 'Project rule', 'Role rule', 'Slot rule', 'review']) {
    assert.ok(resolved.instructions.includes(text), `missing ${text}`);
  }
  assert.equal(resolved.cwd, temporary);
  assert.equal(resolved.model, 'gpt-test');
  assert.equal(resolved.sandbox, 'read-only');
  assert.equal(settings.agent_slots.length, 6);
  assert.ok(settingsModule.safetyWarnings({ ...settings, agent_slots: settings.agent_slots.map((slot, index) => index === 2 ? { ...slot, approval_policy: 'never' } : slot) }).some((warning) => warning.includes('Agent 3')));
  assert.throws(() => settingsModule.validateAgentSlots(settings.agent_slots.map((slot, index) => index === 0 ? { ...slot, working_directory: 'relative/path' } : slot)), /must be absolute/);

  const askSettings = settingsModule.normalize({ ...settings, interaction_mode: 'ask' });
  const askResolved = agentRules.resolve(askSettings, 0);
  assert.equal(askResolved.interactionMode, 'ask');
  assert.equal(askResolved.sandbox, 'read-only');
  assert.ok(askResolved.instructions.includes('Ask mode'));
  assert.ok(askResolved.instructions.includes('Do not edit files'));

  const originalLoad = settingsModule.load;
  settingsModule.load = () => settings;
  try {
    const { CodexBridge } = require('../src/providers/codex-bridge');
    const codexCommand = new CodexBridge()._codexSubcommand('', 2);
    assert.ok(codexCommand.includes('developer_instructions='));
    assert.ok(codexCommand.includes('Global rule'));
    assert.ok(codexCommand.includes('sandbox_mode='));

  } finally {
    settingsModule.load = originalLoad;
  }

  fs.writeFileSync(saved.path, '{"rules":"unmanaged"}\n');
  assert.throws(() => agentRules.saveProject(temporary, 'replace'), /Refusing to overwrite/);
  console.log('agent rule layering, launch flags and safe project storage: ok');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
