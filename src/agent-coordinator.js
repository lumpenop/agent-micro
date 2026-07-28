const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const STATE_FILE = process.env.AGENT_MICRO_COORDINATOR_STATE
  ? path.resolve(process.env.AGENT_MICRO_COORDINATOR_STATE)
  : path.join(os.homedir(), '.agent-micro', 'coordinator.json');

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
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { projects: {} };
  } catch {
    return { projects: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const temp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temp, STATE_FILE);
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
  if (!exists) return { ...record, state: 'missing', files: [], dirty: false, ahead: 0 };
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
  const project = state.projects[root] || { root, slots: {} };
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
  return {
    ok: true,
    root,
    baseBranch: await currentBranch(root),
    slots: inspected.map((record) => record && ({
      ...record,
      conflicts: conflicts.filter((item) => item.slots.includes(record.slot)).map((item) => item.file),
    })),
    conflicts,
  };
}

async function createTask(cwd, input = {}) {
  const root = await repoRoot(cwd);
  const slot = Math.max(0, Math.min(5, Number(input.slot) || 0));
  const task = String(input.task || '').trim().slice(0, 240);
  if (!task) return { ok: false, error: 'Enter a task for this Agent' };
  const rootDirty = await runGit(root, ['status', '--porcelain=v1']);
  const state = loadState();
  const project = state.projects[root] || { root, slots: {} };
  const existing = project.slots?.[slot];
  if (existing?.worktree && fs.existsSync(existing.worktree)) {
    return { ok: false, error: `Agent ${slot + 1} already owns an isolated task` };
  }

  const baseBranch = await currentBranch(root);
  const baseCommit = await runGit(root, ['rev-parse', 'HEAD']);
  const stamp = Date.now().toString(36);
  const branch = `agent-micro/a${slot + 1}-${safeSlug(task)}-${stamp}`;
  const repoName = safeSlug(path.basename(root));
  const worktreeRoot = path.join(path.dirname(root), '.agent-micro-worktrees', repoName);
  const worktree = path.join(worktreeRoot, `agent-${slot + 1}-${stamp}`);
  fs.mkdirSync(worktreeRoot, { recursive: true });
  await runGit(root, ['worktree', 'add', '-b', branch, worktree, baseCommit], 60000);

  const record = {
    slot,
    task,
    root,
    worktree,
    branch,
    baseBranch,
    baseCommit,
    baseHadLocalChanges: !!rootDirty,
    createdAt: new Date().toISOString(),
  };
  project.slots = { ...(project.slots || {}), [slot]: record };
  state.projects[root] = project;
  saveState(state);
  return { ok: true, record: await inspectRecord(record) };
}

async function mergeTask(cwd, slotInput) {
  const root = await repoRoot(cwd);
  const slot = Math.max(0, Math.min(5, Number(slotInput) || 0));
  const state = loadState();
  const record = state.projects[root]?.slots?.[slot];
  if (!record || !fs.existsSync(record.worktree)) return { ok: false, error: 'Isolated task not found' };
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
    const output = await runGit(root, ['merge', '--no-ff', '--no-edit', record.branch], 120000);
    record.mergedAt = new Date().toISOString();
    saveState(state);
    return { ok: true, output, record: await inspectRecord(record) };
  } catch (error) {
    const merging = fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'));
    return {
      ok: false,
      conflict: merging,
      error: merging
        ? 'Merge conflict detected. Resolve it in the main workspace, then commit or abort the merge.'
        : error.message,
    };
  }
}

async function archiveTask(cwd, slotInput) {
  const root = await repoRoot(cwd);
  const slot = Math.max(0, Math.min(5, Number(slotInput) || 0));
  const state = loadState();
  const project = state.projects[root];
  const record = project?.slots?.[slot];
  if (!record) return { ok: false, error: 'Isolated task not found' };
  const task = await inspectRecord(record);
  if (task.dirty) return { ok: false, error: 'Commit or discard Agent changes before cleanup' };
  if (task.ahead > 0 && !task.mergedAt) return { ok: false, error: 'Merge this task before cleanup' };
  if (fs.existsSync(record.worktree)) {
    await runGit(root, ['worktree', 'remove', record.worktree], 60000);
  }
  await runGit(root, ['branch', '-d', record.branch]).catch(() => '');
  delete project.slots[slot];
  saveState(state);
  return { ok: true, slot, worktree: record.worktree, branch: record.branch };
}

module.exports = { list, createTask, mergeTask, archiveTask };
