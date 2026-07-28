const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-micro-coordinator-stress-'));
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
    git(repo, ['config', 'user.email', 'stress@example.test']);
    git(repo, ['config', 'user.name', 'Agent Micro Stress']);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'base']);

    const rounds = 8;
    for (let round = 0; round < rounds; round += 1) {
      const created = await Promise.all(Array.from({ length: 6 }, (_, slot) =>
        coordinator.createTask(repo, { slot, task: `round ${round} slot ${slot}` })));
      assert.ok(created.every((item) => item.ok), `round ${round}: parallel create failed`);
      assert.equal(new Set(created.map((item) => item.record.worktree)).size, 6);

      for (const item of created) {
        const file = `round-${round}-agent-${item.record.slot + 1}.txt`;
        fs.writeFileSync(path.join(item.record.worktree, file), `${round}:${item.record.slot}\n`);
        git(item.record.worktree, ['add', '.']);
        git(item.record.worktree, ['commit', '-m', `round ${round} agent ${item.record.slot + 1}`]);
      }

      const snapshot = await coordinator.list(repo);
      assert.equal(snapshot.conflicts.length, 0, `round ${round}: unexpected overlap`);
      assert.equal(snapshot.slots.filter((slot) => slot?.state === 'ready').length, 6);

      for (let slot = 0; slot < 6; slot += 1) {
        const merged = await coordinator.mergeTask(repo, slot);
        assert.equal(merged.ok, true, `round ${round} slot ${slot}: ${merged.error || 'merge failed'}`);
        const archived = await coordinator.archiveTask(repo, slot);
        assert.equal(archived.ok, true, `round ${round} slot ${slot}: ${archived.error || 'archive failed'}`);
      }
      assert.equal((await coordinator.list(repo)).slots.filter(Boolean).length, 0);
    }

    const finalWorktrees = git(repo, ['worktree', 'list', '--porcelain'])
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '));
    assert.equal(finalWorktrees.length, 1, 'stress run leaked worktrees');
    assert.equal(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), false, 'stress run left a merge in progress');
    process.stdout.write(`coordinator stress: ${rounds * 6} isolated tasks merged and cleaned\n`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
