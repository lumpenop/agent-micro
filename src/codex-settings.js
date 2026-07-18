/**
 * Agent Micro → Codex CLI settings (GUI).
 * Persists to Electron userData + ~/.codex/agent-micro.config.toml (--profile agent-micro).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROFILE = 'agent-micro';
const BEGIN = '# BEGIN agent-micro-managed';
const END = '# END agent-micro-managed';

const DEFAULTS = {
  working_directory: '',
  model: '',
  model_reasoning_effort: '',
  personality: '',
  web_search: '',
  sandbox_mode: 'workspace-write',
  approval_policy: 'on-request',
  writable_roots: [],
  workspace_network_access: false,
  startup_timeout_sec: 30,
  tool_timeout_sec: 60,
  job_max_runtime_seconds: 1800,
  network_proxy: false,
};

const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'];
const REASONING_EFFORTS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const PERSONALITIES = ['', 'friendly', 'pragmatic', 'none'];
const WEB_SEARCH_MODES = ['', 'cached', 'indexed', 'live', 'disabled'];

const CODEXIGNORE_SAMPLE = `# Agent Micro · Codex ignore (context / RAM)
node_modules/
.pnpm-store/
dist/
build/
.next/
.turbo/
coverage/
venv/
.venv/
__pycache__/
*.pyc
.git/
*.png
*.jpg
*.jpeg
*.gif
*.webp
*.mp4
*.mov
*.zip
*.tar
*.gz
*.dmg
*.iso
*.wasm
*.bin
*.lock
package-lock.json
pnpm-lock.yaml
yarn.lock
`;

let userDataDir = null;

function setUserDataPath(dir) {
  userDataDir = dir;
}

function settingsJsonPath() {
  return path.join(userDataDir || os.tmpdir(), 'codex-cli-settings.json');
}

function codexHome() {
  return path.join(os.homedir(), '.codex');
}

function profilePath() {
  return path.join(codexHome(), `${PROFILE}.config.toml`);
}

function userConfigPath() {
  return path.join(codexHome(), 'config.toml');
}

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function normalize(raw = {}) {
  const sandbox = SANDBOX_MODES.includes(raw.sandbox_mode)
    ? raw.sandbox_mode
    : DEFAULTS.sandbox_mode;
  const approval = APPROVAL_POLICIES.includes(raw.approval_policy)
    ? raw.approval_policy
    : DEFAULTS.approval_policy;
  return {
    working_directory: typeof raw.working_directory === 'string'
      ? raw.working_directory.trim().slice(0, 2048) : '',
    model: typeof raw.model === 'string' ? raw.model.trim().slice(0, 120) : '',
    model_reasoning_effort: REASONING_EFFORTS.includes(raw.model_reasoning_effort)
      ? raw.model_reasoning_effort : '',
    personality: PERSONALITIES.includes(raw.personality) ? raw.personality : '',
    web_search: WEB_SEARCH_MODES.includes(raw.web_search) ? raw.web_search : '',
    sandbox_mode: sandbox,
    approval_policy: approval,
    writable_roots: Array.isArray(raw.writable_roots)
      ? [...new Set(raw.writable_roots
        .filter((v) => typeof v === 'string')
        .map((v) => v.trim()).filter(Boolean))].slice(0, 32)
      : [],
    workspace_network_access: !!raw.workspace_network_access,
    startup_timeout_sec: clampInt(raw.startup_timeout_sec, 5, 300, DEFAULTS.startup_timeout_sec),
    tool_timeout_sec: clampInt(raw.tool_timeout_sec, 10, 3600, DEFAULTS.tool_timeout_sec),
    job_max_runtime_seconds: clampInt(
      raw.job_max_runtime_seconds,
      60,
      86400,
      DEFAULTS.job_max_runtime_seconds
    ),
    network_proxy: !!raw.network_proxy,
  };
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function load() {
  try {
    const p = settingsJsonPath();
    if (fs.existsSync(p)) {
      return normalize(JSON.parse(fs.readFileSync(p, 'utf8')));
    }
  } catch {
    /* fall through */
  }
  return { ...DEFAULTS };
}

function profileToml(s) {
  const cfg = normalize(s);
  const optional = [
    cfg.model && `model = ${tomlString(cfg.model)}`,
    cfg.model_reasoning_effort && `model_reasoning_effort = ${tomlString(cfg.model_reasoning_effort)}`,
    cfg.personality && `personality = ${tomlString(cfg.personality)}`,
    cfg.web_search && `web_search = ${tomlString(cfg.web_search)}`,
  ].filter(Boolean).join('\n');
  return `${BEGIN}
# Written by Agent Micro · use: codex --profile ${PROFILE}
${optional ? `${optional}\n` : ''}sandbox_mode = "${cfg.sandbox_mode}"
approval_policy = "${cfg.approval_policy}"
agents.job_max_runtime_seconds = ${cfg.job_max_runtime_seconds}

[sandbox_workspace_write]
writable_roots = [${cfg.writable_roots.map(tomlString).join(', ')}]
network_access = ${cfg.workspace_network_access}

[features.network_proxy]
enabled = ${cfg.network_proxy}

# MCP defaults (copied onto existing [mcp_servers.*] in config.toml on save)
# startup_timeout_sec = ${cfg.startup_timeout_sec}
# tool_timeout_sec = ${cfg.tool_timeout_sec}
${END}
`;
}

/** CLI -c overrides (highest precedence). */
function cliConfigArgs(s = load()) {
  const cfg = normalize(s);
  return [
    cfg.model && `model=${tomlString(cfg.model)}`,
    cfg.model_reasoning_effort && `model_reasoning_effort=${tomlString(cfg.model_reasoning_effort)}`,
    cfg.personality && `personality=${tomlString(cfg.personality)}`,
    cfg.web_search && `web_search=${tomlString(cfg.web_search)}`,
    `sandbox_mode="${cfg.sandbox_mode}"`,
    `approval_policy="${cfg.approval_policy}"`,
    `sandbox_workspace_write.writable_roots=[${cfg.writable_roots.map(tomlString).join(',')}]`,
    `sandbox_workspace_write.network_access=${cfg.workspace_network_access}`,
    `agents.job_max_runtime_seconds=${cfg.job_max_runtime_seconds}`,
    `features.network_proxy.enabled=${cfg.network_proxy}`,
  ].filter(Boolean);
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Append --profile + -c flags to a codex binary invocation. */
function withCliFlags(baseCommand, s = load()) {
  const parts = [baseCommand, '--profile', PROFILE];
  for (const c of cliConfigArgs(s)) {
    parts.push('-c', shellQuote(c));
  }
  return parts.join(' ');
}

function ensureCodexHome() {
  const home = codexHome();
  if (!fs.existsSync(home)) fs.mkdirSync(home, { recursive: true });
  return home;
}

/** Patch existing [mcp_servers.NAME] blocks with timeout defaults. */
function patchMcpTimeouts(toml, startup, tool) {
  const lines = String(toml || '').split(/\r?\n/);
  const out = [];
  let inMcp = false;
  let hasStartup = false;
  let hasTool = false;

  const flush = () => {
    if (!inMcp) return;
    if (!hasStartup) out.push(`startup_timeout_sec = ${startup}`);
    if (!hasTool) out.push(`tool_timeout_sec = ${tool}`);
    inMcp = false;
    hasStartup = false;
    hasTool = false;
  };

  for (const line of lines) {
    const m = line.match(/^\[([^\]]+)\]\s*$/);
    if (m) {
      flush();
      // Only top-level MCP server tables: [mcp_servers.foo]
      inMcp = /^mcp_servers\.[^.]+$/.test(m[1]);
      out.push(line);
      continue;
    }
    if (inMcp) {
      if (/^\s*startup_timeout_sec\s*=/.test(line)) {
        out.push(`startup_timeout_sec = ${startup}`);
        hasStartup = true;
        continue;
      }
      if (/^\s*tool_timeout_sec\s*=/.test(line)) {
        out.push(`tool_timeout_sec = ${tool}`);
        hasTool = true;
        continue;
      }
    }
    out.push(line);
  }
  flush();
  return out.join('\n');
}

function upsertManagedBlock(toml, block) {
  const src = String(toml || '');
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`, 'm');
  if (re.test(src)) return src.replace(re, `${block}\n`);
  const trimmed = src.replace(/\s*$/, '');
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

function removeManagedBlock(toml) {
  return String(toml || '').replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`, 'm'), '').replace(/^\s+/, '');
}

function save(partial) {
  const next = normalize({ ...load(), ...partial });
  const warnings = [];

  const jsonPath = settingsJsonPath();
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(next, null, 2), 'utf8');

  try {
    ensureCodexHome();
    fs.writeFileSync(profilePath(), profileToml(next), 'utf8');
  } catch (e) {
    warnings.push(`profile: ${e.message}`);
  }

  try {
    ensureCodexHome();
    const cfgPath = userConfigPath();
    let toml = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
    // The complete managed settings live in the selected profile file. Remove
    // legacy copies from global config to avoid duplicate TOML tables.
    toml = removeManagedBlock(toml);
    toml = patchMcpTimeouts(toml, next.startup_timeout_sec, next.tool_timeout_sec);
    fs.writeFileSync(cfgPath, toml, 'utf8');
  } catch (e) {
    warnings.push(`config.toml: ${e.message}`);
  }

  return {
    ok: true,
    settings: next,
    profile: PROFILE,
    profilePath: profilePath(),
    configPath: userConfigPath(),
    warning: warnings.length ? warnings.join(' · ') : undefined,
  };
}

function writeCodexIgnore(targetDir) {
  const dir = targetDir || process.cwd();
  const dest = path.join(dir, '.codexignore');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existed = fs.existsSync(dest);
  if (!existed) {
    fs.writeFileSync(dest, CODEXIGNORE_SAMPLE, 'utf8');
  }
  return { ok: true, path: dest, created: !existed, existed };
}

function meta() {
  return {
    defaults: { ...DEFAULTS },
    sandboxModes: SANDBOX_MODES,
    approvalPolicies: APPROVAL_POLICIES,
    reasoningEfforts: REASONING_EFFORTS,
    personalities: PERSONALITIES,
    webSearchModes: WEB_SEARCH_MODES,
    profile: PROFILE,
    profilePath: profilePath(),
    configPath: userConfigPath(),
  };
}

module.exports = {
  DEFAULTS,
  SANDBOX_MODES,
  APPROVAL_POLICIES,
  REASONING_EFFORTS,
  PERSONALITIES,
  WEB_SEARCH_MODES,
  PROFILE,
  setUserDataPath,
  load,
  save,
  meta,
  cliConfigArgs,
  profileToml,
  withCliFlags,
  writeCodexIgnore,
  CODEXIGNORE_SAMPLE,
};
