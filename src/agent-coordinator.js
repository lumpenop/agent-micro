const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const STATE_FILE = process.env.AGENT_MICRO_COORDINATOR_STATE
  ? path.resolve(process.env.AGENT_MICRO_COORDINATOR_STATE)
  : path.join(os.homedir(), '.agent-micro', 'coordinator.json');
const projectQueues = new Map();
const WORKER_SLOTS = [1, 2, 3, 4, 5];
const RUNTIME_GRACE_MS = 8000;
const MAX_AUTO_RESTARTS = 1;

function runGit(cwd, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message).trim()));
      else resolve(String(stdout || '').trim());
    });
  });
}

function safeSlug(value) {
  return String(value || 'task')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'task';
}

function loadState() {
  for (const file of [STATE_FILE, `${STATE_FILE}.bak`]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        if (!parsed.projects || typeof parsed.projects !== 'object') parsed.projects = {};
        return parsed;
      }
    } catch {
      /* try the backup */
    }
  }
  return { projects: {} };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const temp = `${STATE_FILE}.tmp`;
  const backup = `${STATE_FILE}.bak`;
  const backupTemp = `${backup}.tmp`;
  if (fs.existsSync(STATE_FILE)) {
    fs.copyFileSync(STATE_FILE, backupTemp);
    fs.renameSync(backupTemp, backup);
  }
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temp, STATE_FILE);
}

function projectState(state, root) {
  const project = state.projects[root] || { root, slots: {}, completed: {} };
  if (!project.slots || typeof project.slots !== 'object') project.slots = {};
  if (!project.completed || typeof project.completed !== 'object') project.completed = {};
  for (const [slot, record] of Object.entries(project.slots)) {
    if (record && !record.id) record.id = `legacy-a${Number(slot) + 1}-${safeSlug(record.branch || record.task)}`;
    if (record && !Array.isArray(record.dependsOn)) record.dependsOn = dependencyIds(record.dependsOn);
  }
  state.projects[root] = project;
  return project;
}

function dependencyIds(input) {
  const values = Array.isArray(input) ? input : input ? [input] : [];
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 5);
}

function dependencyState(project, record) {
  const ids = dependencyIds(record.dependsOn);
  const active = Object.values(project.slots || {}).filter(Boolean);
  const details = ids.map((id) => {
    const task = active.find((candidate) => candidate.id === id);
    if (task?.mergedAt || project.completed?.[id]) return { id, state: 'merged', task: task?.task || project.completed[id]?.task || id };
    if (task) return { id, state: 'waiting', task: task.task };
    return { id, state: 'missing', task: id };
  });
  return {
    dependencies: details,
    dependenciesReady: details.every((item) => item.state === 'merged'),
    blockedBy: details.filter((item) => item.state !== 'merged'),
  };
}

async function withProjectLock(root, operation) {
  const previous = projectQueues.get(root) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  projectQueues.set(root, current);
  try {
    return await current;
  } finally {
    if (projectQueues.get(root) === current) projectQueues.delete(root);
  }
}

async function repoRoot(cwd) {
  const top = path.resolve(await runGit(cwd, ['rev-parse', '--show-toplevel']));
  const commonRaw = await runGit(cwd, ['rev-parse', '--git-common-dir']).catch(() => '');
  const common = commonRaw ? path.resolve(top, commonRaw) : '';
  return common && path.basename(common) === '.git' ? path.dirname(common) : top;
}

async function currentBranch(cwd) {
  return (await runGit(cwd, ['branch', '--show-current'])) || 'HEAD';
}

async function changedFiles(record) {
  const committed = await runGit(record.worktree, ['diff', '--name-only', `${record.baseCommit}...HEAD`]).catch(() => '');
  const pending = await runGit(record.worktree, ['status', '--porcelain=v1']).catch(() => '');
  const files = new Set(committed.split(/\r?\n/).filter(Boolean));
  for (const line of pending.split(/\r?\n/)) {
    if (!line) continue;
    const file = line.slice(3).split(' -> ').pop();
    if (file) files.add(file);
  }
  return [...files].sort();
}

async function inspectRecord(record) {
  const exists = !!record.worktree && fs.existsSync(record.worktree);
  if (!exists) {
    const branchExists = await runGit(record.root, ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`])
      .then(() => true, () => false);
    return {
      ...record,
      state: branchExists ? 'recoverable' : 'missing',
      recoverable: branchExists,
      files: [],
      dirty: false,
      ahead: 0,
    };
  }
  const porcelain = await runGit(record.worktree, ['status', '--porcelain=v1']).catch(() => '');
  const aheadText = await runGit(record.worktree, ['rev-list', '--count', `${record.baseCommit}..HEAD`]).catch(() => '0');
  const files = await changedFiles(record);
  return {
    ...record,
    state: porcelain ? 'working' : Number(aheadText) > 0 ? 'ready' : 'idle',
    files,
    dirty: !!porcelain,
    ahead: Number(aheadText) || 0,
  };
}

async function list(cwd) {
  const root = await repoRoot(cwd);
  const state = loadState();
  const project = projectState(state, root);
  const slots = Array.from({ length: 6 }, (_, slot) => project.slots?.[slot] || null);
  const inspected = await Promise.all(slots.map((record) => record ? inspectRecord(record) : null));
  const owners = new Map();
  for (const record of inspected.filter(Boolean)) {
    for (const file of record.files) {
      const entries = owners.get(file) || [];
      entries.push(record.slot);
      owners.set(file, entries);
    }
  }
  const conflicts = [...owners.entries()]
    .filter(([, slotList]) => slotList.length > 1)
    .map(([file, slotList]) => ({ file, slots: slotList }));
  const enriched = inspected.map((record) => {
    if (!record) return null;
    return {
      ...record,
      ...dependencyState(project, record),
      conflicts: conflicts.filter((item) => item.slots.includes(record.slot)).map((item) => item.file),
    };
  });
  const queue = enriched
    .filter((record) => record && !record.mergedAt)
    .sort((a, b) => {
      if (a.dependenciesReady !== b.dependenciesReady) return a.dependenciesReady ? -1 : 1;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    })
    .map((record, index) => ({ id: record.id, slot: record.slot, position: index + 1, ready: record.dependenciesReady }));
  const queueById = new Map(queue.map((item) => [item.id, item]));
  const queuedSlots = enriched.map((record) => record && ({
    ...record,
    queuePosition: queueById.get(record.id)?.position || null,
  }));
  return {
    ok: true,
    root,
    baseBranch: await currentBranch(root),
    slots: queuedSlots,
    conflicts,
    queue,
  };
}

async function createTask(cwd, input = {}) {
  const root = await repoRoot(cwd);
  return withProjectLock(root, () => createTaskLocked(root, input));
}

async function createTaskLocked(root, input = {}) {
  const task = String(input.task || '').trim().slice(0, 240);
  if (!task) return { ok: false, error: 'Enter a task for this Agent' };
  const state = loadState();
  const project = projectState(state, root);
  const automatic = input.slot === undefined || input.slot === null || input.slot === '' || input.slot === 'auto';
  const slot = automatic
    ? WORKER_SLOTS.find((candidate) => !project.slots?.[candidate])
    : Math.max(0, Math.min(5, Number(input.slot) || 0));
  if (slot === undefined) return { ok: false, full: true, error: 'All worker Agents already own an isolated task' };
  const dependsOn = dependencyIds(input.dependsOn);
  const knownIds = new Set([
    ...Object.values(project.slots || {}).filter(Boolean).map((record) => record.id),
    ...Object.keys(project.completed || {}),
  ]);
  const unknownDependency = dependsOn.find((id) => !knownIds.has(id));
  if (unknownDependency) return { ok: false, error: 'The selected merge dependency is no longer available' };
  const rootDirty = await runGit(root, ['status', '--porcelain=v1']);
  const existing = project.slots?.[slot];
  if (existing?.worktree && fs.existsSync(existing.worktree)) {
    return { ok: false, error: `Agent ${slot + 1} already owns an isolated task` };
  }
  if (existing?.branch) {
    const branchExists = await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${existing.branch}`])
      .then(() => true, () => false);
    if (branchExists) {
      return { ok: false, recoverable: true, error: `Agent ${slot + 1} has a recoverable isolated task` };
    }
    delete project.slots[slot];
  }

  const baseBranch = await currentBranch(root);
  const baseCommit = await runGit(root, ['rev-parse', 'HEAD']);
  const stamp = Date.now().toString(36);
  const id = `task-${stamp}-a${slot + 1}`;
  const branch = `agent-micro/a${slot + 1}-${safeSlug(task)}-${stamp}`;
  const repoName = safeSlug(path.basename(root));
  const worktreeRoot = path.join(path.dirname(root), '.agent-micro-worktrees', repoName);
  const worktree = path.join(worktreeRoot, `agent-${slot + 1}-${stamp}`);
  fs.mkdirSync(worktreeRoot, { recursive: true });
  await runGit(root, ['worktree', 'add', '-b', branch, worktree, baseCommit], 60000);

  const record = {
    id,
    slot,
    task,
    dependsOn,
    root,
    worktree,
    branch,
    baseBranch,
    baseCommit,
    baseHadLocalChanges: !!rootDirty,
    createdAt: new Date().toISOString(),
    runtime: {
      expectedOpen: false,
      health: 'not-started',
      autoRestartCount: 0,
    },
  };
  project.slots = { ...(project.slots || {}), [slot]: record };
  state.projects[root] = project;
  saveState(state);
  return { ok: true, record: await inspectRecord(record) };
}

async function mergeTask(cwd, slotInput) {
  const root = await repoRoot(cwd);
  return withProjectLock(root, () => mergeTaskLocked(root, slotInput));
}

async function mergeTaskLocked(root, slotInput) {
  const slot = Math.max(0, Math.min(5, Number(slotInput) || 0));
  const state = loadState();
  const project = projectState(state, root);
  const record = project.slots?.[slot];
  if (!record || !fs.existsSync(record.worktree)) return { ok: false, error: 'Isolated task not found' };
  const dependency = dependencyState(project, record);
  if (!dependency.dependenciesReady) {
    return {
      ok: false,
      dependencyBlocked: true,
      error: `Merge queue is waiting for: ${dependency.blockedBy.map((item) => item.task).slice(0, 3).join(', ')}`,
    };
  }
  const task = await inspectRecord(record);
  const snapshot = await list(root);
  const overlap = snapshot.slots?.[slot]?.conflicts || [];
  if (overlap.length) {
    return { ok: false, error: `Another Agent also changed: ${overlap.slice(0, 3).join(', ')}` };
  }
  if (task.dirty) return { ok: false, error: 'Commit the Agent changes before merging' };
  if (!task.ahead) return { ok: false, error: 'There are no Agent commits to merge' };
  const rootDirty = await runGit(root, ['status', '--porcelain=v1']);
  if (rootDirty) return { ok: false, error: 'Main workspace has uncommitted changes; commit or stash them first' };
  const branch = await currentBranch(root);
  if (branch !== record.baseBranch) {
    return { ok: false, error: `Switch the main workspace to ${record.baseBranch} before merging` };
  }
  try {
    await runGit(root, ['merge-tree', '--write-tree', 'HEAD', record.branch], 60000);
  } catch (error) {
    return { ok: false, conflict: true, error: 'Merge conflict detected before main was changed. Review the Agent branch first.' };
  }
  try {
    const output = await runGit(root, ['merge', '--no-ff', '--no-edit', record.branch], 120000);
    record.mergedAt = new Date().toISOString();
    saveState(state);
    return { ok: true, output, record: await inspectRecord(record) };
  } catch (error) {
    const merging = fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'));
    if (merging) await runGit(root, ['merge', '--abort'], 30000).catch(() => '');
    return {
      ok: false,
      conflict: merging,
      error: merging
        ? 'Merge conflict detected. Main workspace was restored automatically.'
        : error.message,
    };
  }
}

async function archiveTask(cwd, slotInput) {
  const root = await repoRoot(cwd);
  return withProjectLock(root, () => archiveTaskLocked(root, slotInput));
}

async function archiveTaskLocked(root, slotInput) {
  const slot = Math.max(0, Math.min(5, Number(slotInput) || 0));
  const state = loadState();
  const project = state.projects[root] ? projectState(state, root) : null;
  const record = project?.slots?.[slot];
  if (!record) return { ok: false, error: 'Isolated task not found' };
  const task = await inspectRecord(record);
  if (task.dirty) return { ok: false, error: 'Commit or discard Agent changes before cleanup' };
  const merged = await runGit(root, ['merge-base', '--is-ancestor', record.branch, 'HEAD'])
    .then(() => true, () => false);
  if (task.ahead > 0 && !merged) return { ok: false, error: 'Merge this task before cleanup' };
  if (fs.existsSync(record.worktree)) {
    await runGit(root, ['worktree', 'remove', record.worktree], 60000);
  }
  await runGit(root, ['branch', '-d', record.branch]).catch(() => '');
  if (record.id && (record.mergedAt || merged)) {
    project.completed[record.id] = {
      id: record.id,
      task: record.task,
      branch: record.branch,
      mergedAt: record.mergedAt || new Date().toISOString(),
    };
  }
  delete project.slots[slot];
  saveState(state);
  return { ok: true, slot, worktree: record.worktree, branch: record.branch };
}

async function restoreTask(cwd, slotInput) {
  const root = await repoRoot(cwd);
  return withProjectLock(root, () => restoreTaskLocked(root, slotInput));
}

async function restoreTaskLocked(root, slotInput) {
  const slot = Math.max(0, Math.min(5, Number(slotInput) || 0));
  const state = loadState();
  const record = state.projects[root]?.slots?.[slot];
  if (!record) return { ok: false, error: 'Isolated task not found' };
  if (record.worktree && fs.existsSync(record.worktree)) {
    return { ok: true, alreadyPresent: true, record: await inspectRecord(record) };
  }
  const branchExists = await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`])
    .then(() => true, () => false);
  if (!branchExists) return { ok: false, error: 'The Agent branch no longer exists' };
  fs.mkdirSync(path.dirname(record.worktree), { recursive: true });
  await runGit(root, ['worktree', 'prune'], 30000).catch(() => '');
  await runGit(root, ['worktree', 'add', record.worktree, record.branch], 60000);
  record.restoredAt = new Date().toISOString();
  saveState(state);
  return { ok: true, restored: true, record: await inspectRecord(record) };
}

async function recordLaunch(cwd, slotInput, result = {}, options = {}) {
  const root = await repoRoot(cwd);
  return withProjectLock(root, async () => {
    const slot = Math.max(0, Math.min(5, Number(slotInput) || 0));
    const state = loadState();
    const project = projectState(state, root);
    const record = project.slots?.[slot];
    if (!record) return { ok: false, error: 'Isolated task not found' };
    const now = new Date(options.now || Date.now()).toISOString();
    const runtime = { ...(record.runtime || {}) };
    runtime.expectedOpen = options.trackOpen !== false && result?.ok !== false;
    runtime.health = result?.ok === false ? 'attention' : 'live';
    runtime.lastLaunchAt = result?.ok === false ? runtime.lastLaunchAt : now;
    runtime.lastLaunchError = result?.ok === false ? String(result.error || result.reason || 'launch failed').slice(0, 240) : '';
    runtime.missingSince = null;
    if (!options.automatic) runtime.autoRestartCount = 0;
    record.runtime = runtime;
    saveState(state);
    return { ok: true, slot, runtime };
  });
}

async function observeRuntime(cwd, openSlots = [], options = {}) {
  const root = await repoRoot(cwd);
  return withProjectLock(root, async () => {
    const state = loadState();
    const project = projectState(state, root);
    const open = new Set((openSlots || []).map((value) => Number(value)));
    const nowMs = Number(options.now || Date.now());
    const retries = [];
    let changed = false;
    for (const record of Object.values(project.slots || {}).filter(Boolean)) {
      const runtime = { health: 'not-started', autoRestartCount: 0, ...(record.runtime || {}) };
      if (record.mergedAt) {
        if (runtime.health !== 'complete') changed = true;
        runtime.health = 'complete';
        runtime.expectedOpen = false;
        runtime.missingSince = null;
      } else if (open.has(record.slot)) {
        if (runtime.health !== 'live' || runtime.missingSince) changed = true;
        runtime.health = 'live';
        runtime.lastSeenAt = new Date(nowMs).toISOString();
        runtime.missingSince = null;
      } else if (runtime.expectedOpen) {
        if (!runtime.missingSince) {
          runtime.missingSince = new Date(nowMs).toISOString();
          runtime.health = 'checking';
          changed = true;
        } else if (nowMs - Date.parse(runtime.missingSince) >= RUNTIME_GRACE_MS) {
          const canRetry = Number(runtime.autoRestartCount || 0) < MAX_AUTO_RESTARTS;
          runtime.health = canRetry ? 'stopped' : 'attention';
          if (options.claimRetries && canRetry) {
            runtime.health = 'restarting';
            runtime.autoRestartCount = Number(runtime.autoRestartCount || 0) + 1;
            runtime.lastRetryAt = new Date(nowMs).toISOString();
            retries.push(record.slot);
          }
          changed = true;
        }
      }
      record.runtime = runtime;
    }
    if (changed) saveState(state);
    return { ok: true, root, retries: retries.sort((a, b) => a - b) };
  });
}

module.exports = {
  WORKER_SLOTS,
  list,
  createTask,
  mergeTask,
  archiveTask,
  restoreTask,
  recordLaunch,
  observeRuntime,
};
