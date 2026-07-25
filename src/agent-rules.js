const fs = require('fs');
const path = require('path');
const { rootFor } = require('./agent-project-context');

const MANAGED_BY = 'Agent Micro';
const MAX_RULES = 20000;

function cleanRules(value) {
  return String(value || '').trim().slice(0, MAX_RULES);
}

function validDirectory(value) {
  const candidate = String(value || '').trim();
  if (!path.isAbsolute(candidate)) return null;
  try { return fs.statSync(candidate).isDirectory() ? path.resolve(candidate) : null; } catch { return null; }
}

function projectRoot(cwd) {
  const directory = validDirectory(cwd);
  return directory ? rootFor(directory, directory) || directory : null;
}

function projectRulesPath(cwd) {
  const root = projectRoot(cwd);
  return root ? path.join(root, '.agent-micro', 'rules.json') : null;
}

function loadProject(cwd) {
  const root = projectRoot(cwd);
  const file = projectRulesPath(root);
  if (!root || !file) return { ok: true, root: null, path: null, rules: '' };
  try {
    if (!fs.existsSync(file)) return { ok: true, root, path: file, rules: '' };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, root, path: file, rules: cleanRules(parsed?.rules) };
  } catch (error) {
    return { ok: false, root, path: file, rules: '', error: error.message };
  }
}

function saveProject(cwd, rules) {
  const current = loadProject(cwd);
  if (!current.root || !current.path) throw new Error('Choose a valid project folder before saving project rules');
  if (fs.existsSync(current.path)) {
    const parsed = JSON.parse(fs.readFileSync(current.path, 'utf8'));
    if (parsed?.managedBy !== MANAGED_BY) {
      throw new Error('Refusing to overwrite a rules file managed by another tool');
    }
  }
  fs.mkdirSync(path.dirname(current.path), { recursive: true });
  fs.writeFileSync(current.path, `${JSON.stringify({ version: 1, managedBy: MANAGED_BY, rules: cleanRules(rules) }, null, 2)}\n`, 'utf8');
  return { ok: true, root: current.root, path: current.path, rules: cleanRules(rules) };
}

function slotConfig(settings, slot) {
  const index = Math.max(0, Math.min(5, Number(slot) || 0));
  const fallback = require('./codex-settings').defaultAgentSlots()[index];
  return settings?.agent_slots?.[index] || fallback;
}

function effectiveWorkingDirectory(settings, slot) {
  const profile = slotConfig(settings, slot);
  return validDirectory(profile.working_directory)
    || validDirectory(settings?.working_directory)
    || process.env.HOME
    || process.cwd();
}

function resolve(settings, slot) {
  const configuredProfile = slotConfig(settings, slot);
  const profile = configuredProfile.enabled === false
    ? require('./codex-settings').defaultAgentSlots()[Math.max(0, Math.min(5, Number(slot) || 0))]
    : configuredProfile;
  const cwd = effectiveWorkingDirectory(settings, slot);
  const project = loadProject(cwd);
  const role = (settings?.agent_roles || []).find((item) => item.id === profile.role_id && item.enabled !== false);
  const sections = [
    ['Global rules', settings?.global_agent_rules],
    ['Project rules', project.rules],
    [role?.name ? `Role · ${role.name}` : 'Role', role?.developer_instructions],
    [`Agent ${Number(slot) + 1} rules`, profile.rules],
  ].filter(([, rules]) => cleanRules(rules));
  if (profile.preferred_skills?.length) {
    sections.push(['Preferred skills', `Prefer these skills when relevant: ${profile.preferred_skills.join(', ')}`]);
  }
  return {
    profile,
    role,
    cwd,
    project,
    instructions: sections.map(([title, rules]) => `## ${title}\n${cleanRules(rules)}`).join('\n\n'),
    model: profile.model || role?.model || settings?.model || '',
    reasoning: profile.model_reasoning_effort || role?.model_reasoning_effort || settings?.model_reasoning_effort || '',
    sandbox: profile.sandbox_mode || settings?.sandbox_mode || 'workspace-write',
    approval: profile.approval_policy || settings?.approval_policy || 'on-request',
  };
}

module.exports = { cleanRules, effectiveWorkingDirectory, loadProject, projectRoot, resolve, saveProject };
