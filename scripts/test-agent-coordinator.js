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

    fs.writeFileSync(path.join(repo, 'preflight.txt'), 'base\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'preflight base']);
    const preflight = await coordinator.createTask(repo, { slot: 4, task: 'preflight conflict' });
    if (!preflight.ok) throw new Error('preflight worktree creation failed');
    fs.writeFileSync(path.join(preflight.record.worktree, 'preflight.txt'), 'agent branch\n');
    git(preflight.record.worktree, ['add', '.']);
    git(preflight.record.worktree, ['commit', '-m', 'agent-side conflict']);
    fs.writeFileSync(path.join(repo, 'preflight.txt'), 'main branch\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'main-side conflict']);
    const blockedPreflight = await coordinator.mergeTask(repo, 4);
    if (blockedPreflight.ok || !blockedPreflight.conflict) {
      throw new Error('real Git merge conflict was not blocked before merge');
    }
    if (fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))) {
      throw new Error('conflict preflight left main in a merge state');
    }

    const recoverable = await coordinator.createTask(repo, { slot: 5, task: 'recover after missing folder' });
    if (!recoverable.ok) throw new Error('recoverable worktree creation failed');
    fs.writeFileSync(path.join(recoverable.record.worktree, 'recovered.txt'), 'safe\n');
    git(recoverable.record.worktree, ['add', '.']);
    git(recoverable.record.worktree, ['commit', '-m', 'recoverable result']);
    git(repo, ['worktree', 'remove', recoverable.record.worktree]);
    const missing = await coordinator.list(repo);
    if (missing.slots[5]?.state !== 'recoverable') throw new Error('missing worktree was not marked recoverable');
    const restored = await coordinator.restoreTask(repo, 5);
    if (!restored.ok || !fs.existsSync(recoverable.record.worktree)) throw new Error('worktree restore failed');

    const queueRepo = path.join(temp, 'queue-repo');
    fs.mkdirSync(queueRepo);
    git(queueRepo, ['init', '-b', 'main']);
    git(queueRepo, ['config', 'user.email', 'queue@example.test']);
    git(queueRepo, ['config', 'user.name', 'Agent Micro Queue Test']);
    fs.writeFileSync(path.join(queueRepo, 'base.txt'), 'base\n');
    git(queueRepo, ['add', '.']);
    git(queueRepo, ['commit', '-m', 'base']);

    const automaticFirst = await coordinator.createTask(queueRepo, { slot: 'auto', task: 'automatic first worker' });
    if (!automaticFirst.ok || automaticFirst.record.slot !== 1) {
      throw new Error(`automatic worker allocation failed: ${JSON.stringify(automaticFirst)}`);
    }
    const automaticSecond = await coordinator.createTask(queueRepo, {
      slot: 'auto',
      task: 'merge after first worker',
      dependsOn: automaticFirst.record.id,
    });
    if (!automaticSecond.ok || automaticSecond.record.slot !== 2) {
      throw new Error(`second automatic worker allocation failed: ${JSON.stringify(automaticSecond)}`);
    }
    fs.writeFileSync(path.join(automaticFirst.record.worktree, 'first.txt'), 'first\n');
    git(automaticFirst.record.worktree, ['add', '.']);
    git(automaticFirst.record.worktree, ['commit', '-m', 'first worker']);
    fs.writeFileSync(path.join(automaticSecond.record.worktree, 'second.txt'), 'second\n');
    git(automaticSecond.record.worktree, ['add', '.']);
    git(automaticSecond.record.worktree, ['commit', '-m', 'second worker']);
    const queued = await coordinator.list(queueRepo);
    if (queued.slots[1].queuePosition !== 1 || queued.slots[2].queuePosition !== 2 || queued.slots[2].dependenciesReady) {
      throw new Error('merge queue order was not calculated');
    }
    const blockedDependency = await coordinator.mergeTask(queueRepo, 2);
    if (blockedDependency.ok || !blockedDependency.dependencyBlocked) {
      throw new Error('dependency merge was not blocked');
    }
    const firstMerged = await coordinator.mergeTask(queueRepo, 1);
    if (!firstMerged.ok) throw new Error(`first queued merge failed: ${firstMerged.error}`);
    const firstCleaned = await coordinator.archiveTask(queueRepo, 1);
    if (!firstCleaned.ok) throw new Error(`first queued cleanup failed: ${firstCleaned.error}`);
    const afterDependency = await coordinator.list(queueRepo);
    if (!afterDependency.slots[2].dependenciesReady) throw new Error('completed dependency was not retained after cleanup');
    const secondMerged = await coordinator.mergeTask(queueRepo, 2);
    if (!secondMerged.ok) throw new Error(`second queued merge failed: ${secondMerged.error}`);

    const reusedWorker = await coordinator.createTask(queueRepo, { slot: 'auto', task: 'reuse lowest free worker' });
    if (!reusedWorker.ok || reusedWorker.record.slot !== 1) throw new Error('lowest free worker was not reused');
    await coordinator.recordLaunch(queueRepo, 1, { ok: true }, { now: 1000 });
    const grace = await coordinator.observeRuntime(queueRepo, [], { now: 2000, claimRetries: true });
    if (grace.retries.length) throw new Error('runtime retried before the grace period');
    const firstRetry = await coordinator.observeRuntime(queueRepo, [], { now: 10000, claimRetries: true });
    if (firstRetry.retries.length !== 1 || firstRetry.retries[0] !== 1) {
      throw new Error('stopped runtime did not claim one safe retry');
    }
    await coordinator.recordLaunch(queueRepo, 1, { ok: true }, { now: 11000, automatic: true });
    await coordinator.observeRuntime(queueRepo, [], { now: 12000, claimRetries: true });
    const exhausted = await coordinator.observeRuntime(queueRepo, [], { now: 21000, claimRetries: true });
    const exhaustedState = await coordinator.list(queueRepo);
    if (exhausted.retries.length || exhaustedState.slots[1].runtime.health !== 'attention') {
      throw new Error('runtime exceeded the single automatic retry limit');
    }

    process.stdout.write('agent coordinator ok\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
