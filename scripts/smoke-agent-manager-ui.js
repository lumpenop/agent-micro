const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const port = Number(process.argv[2] || 9333);
const project = process.argv[3] || process.cwd();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const integrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-micro-ui-integration-'));
  const integrationRepo = path.join(integrationRoot, 'repo');
  fs.mkdirSync(integrationRepo);
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(integrationRepo, ['init', '-b', 'main']);
  git(integrationRepo, ['config', 'user.email', 'agent-micro@example.test']);
  git(integrationRepo, ['config', 'user.name', 'Agent Micro UI Test']);
  fs.writeFileSync(path.join(integrationRepo, 'base.txt'), 'base\n');
  git(integrationRepo, ['add', '.']);
  git(integrationRepo, ['commit', '-m', 'base']);

  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const target = targets.find((entry) => entry.type === 'page' && entry.title === 'Agent Micro');
  if (!target?.webSocketDebuggerUrl) throw new Error('Agent Micro renderer target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Renderer evaluation failed');
    return result.result?.value;
  };

  await command('Runtime.enable');
  await evaluate(`window.codexDesktop.saveCodexSettings({ working_directory: ${JSON.stringify(integrationRepo)} })`);
  const apiReady = await evaluate(`[
    'listAgentTasks','createAgentTask','launchAgentTask','mergeAgentTask','archiveAgentTask'
  ].every((name) => typeof window.codexDesktop[name] === 'function')`);
  if (!apiReady) throw new Error('Agent Manager preload API is incomplete');
  const created = await evaluate(`window.codexDesktop.createAgentTask({
    slot: 5,
    task: 'renderer IPC integration'
  })`);
  if (!created?.ok || !created.record?.worktree) {
    throw new Error(`Agent task IPC creation failed: ${JSON.stringify(created)}`);
  }
  fs.writeFileSync(path.join(created.record.worktree, 'integrated.txt'), 'renderer IPC merge\n');
  git(created.record.worktree, ['add', '.']);
  git(created.record.worktree, ['commit', '-m', 'renderer IPC merge']);
  const beforeMerge = await evaluate(`window.codexDesktop.listAgentTasks()`);
  if (beforeMerge.slots?.[5]?.state !== 'ready' || beforeMerge.slots[5].ahead !== 1) {
    throw new Error(`Agent task IPC status failed: ${JSON.stringify(beforeMerge.slots?.[5])}`);
  }
  const merged = await evaluate(`window.codexDesktop.mergeAgentTask(5)`);
  if (!merged?.ok || !fs.existsSync(path.join(integrationRepo, 'integrated.txt'))) {
    throw new Error(`Agent task IPC merge failed: ${JSON.stringify(merged)}`);
  }
  const coordinator = require('../src/agent-coordinator');
  const archived = await coordinator.archiveTask(integrationRepo, 5);
  if (!archived?.ok) throw new Error(`Agent task cleanup failed: ${JSON.stringify(archived)}`);
  await evaluate(`window.codexDesktop.saveCodexSettings({ working_directory: ${JSON.stringify(project)} })`);
  await evaluate(`document.getElementById('btn-agents').click()`);
  await wait(900);
  const opened = await evaluate(`(() => {
    const panel = document.getElementById('agent-manager-panel');
    return {
      hidden: panel.hidden,
      active: document.getElementById('btn-agents').classList.contains('is-active'),
      cards: document.querySelectorAll('.agent-task-card').length,
      summary: document.getElementById('agent-manager-summary').textContent,
      width: window.innerWidth
    };
  })()`);
  if (opened.hidden || !opened.active || opened.cards !== 6 || opened.width < 760) {
    throw new Error(`Agent Manager open state invalid: ${JSON.stringify(opened)}`);
  }
  await evaluate(`document.getElementById('agent-manager-close').click()`);
  await wait(400);
  const closed = await evaluate(`({
    hidden: document.getElementById('agent-manager-panel').hidden,
    active: document.getElementById('btn-agents').classList.contains('is-active'),
    width: window.innerWidth
  })`);
  if (!closed.hidden || closed.active || closed.width > 560) {
    throw new Error(`Agent Manager close state invalid: ${JSON.stringify(closed)}`);
  }
  socket.close();
  fs.rmSync(integrationRoot, { recursive: true, force: true });
  process.stdout.write(`agent manager ui ok · ${opened.summary}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
