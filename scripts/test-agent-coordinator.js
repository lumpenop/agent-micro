const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-micro-coordinator-'));
process.env.AGENT_MICRO_COORDINATOR_STATE = path.join(temp, 'state.json');
const coordinator = require('../src/agent-coordinator');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

(async () => {
  try {
    const repo = path.join(temp, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 'agent-micro@example.test']);
    git(repo, ['config', 'user.name', 'Agent Micro Test']);
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'base']);

    const mergeable = await coordinator.createTask(repo, { slot: 0, task: 'mergeable task' });
    if (!mergeable.ok) throw new Error('mergeable worktree creation failed');
    fs.writeFileSync(path.join(mergeable.record.worktree, 'isolated.txt'), 'isolated result\n');
    git(mergeable.record.worktree, ['add', '.']);
    git(mergeable.record.worktree, ['commit', '-m', 'isolated result']);
    const ready = await coordinator.list(repo);
    if (ready.slots[0].state !== 'ready' || ready.slots[0].ahead !== 1) {
      throw new Error('ready worktree state failed');
    }
    const merged = await coordinator.mergeTask(repo, 0);
    if (!merged.ok || !fs.existsSync(path.join(repo, 'isolated.txt'))) {
      throw new Error(`merge flow failed: ${merged.error || 'file missing'}`);
    }
    const archived = await coordinator.archiveTask(repo, 0);
    if (!archived.ok || fs.existsSync(mergeable.record.worktree)) {
      throw new Error('archive flow failed');
    }

    const first = await coordinator.createTask(repo, { slot: 1, task: 'first conflict task' });
    const second = await coordinator.createTask(repo, { slot: 2, task: 'second conflict task' });
    if (!first.ok || !second.ok) throw new Error('conflict worktree creation failed');

    fs.writeFileSync(path.join(first.record.worktree, 'shared.txt'), 'agent one\n');
    git(first.record.worktree, ['add', '.']);
    git(first.record.worktree, ['commit', '-m', 'agent one']);
    fs.writeFileSync(path.join(second.record.worktree, 'shared.txt'), 'agent two\n');
    git(second.record.worktree, ['add', '.']);
    git(second.record.worktree, ['commit', '-m', 'agent two']);

    const status = await coordinator.list(repo);
    if (!status.ok || status.conflicts.length !== 1 || status.conflicts[0].file !== 'shared.txt') {
      throw new Error('overlap detection failed');
    }
    if (status.slots[1].state !== 'ready' || status.slots[2].state !== 'ready') {
      throw new Error('ready state detection failed');
    }
    const blockedConflict = await coordinator.mergeTask(repo, 1);
    if (blockedConflict.ok || !/Another Agent also changed/.test(blockedConflict.error || '')) {
      throw new Error('conflicting merge was not blocked');
    }

    const dirty = await coordinator.createTask(repo, { slot: 3, task: 'dirty task' });
    if (!dirty.ok) throw new Error('dirty worktree creation failed');
    fs.writeFileSync(path.join(dirty.record.worktree, 'dirty.txt'), 'not committed\n');
    const blockedDirty = await coordinator.mergeTask(repo, 3);
    if (blockedDirty.ok || !/Commit the Agent changes/.test(blockedDirty.error || '')) {
      throw new Error('dirty merge was not blocked');
    }
    process.stdout.write('agent coordinator ok\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
