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
  sandbox_mode: 'workspace-write',
  approval_policy: 'on-request',
  startup_timeout_sec: 30,
  tool_timeout_sec: 60,
  job_max_runtime_seconds: 1800,
  network_proxy: false,
};

const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'];

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
    sandbox_mode: sandbox,
    approval_policy: approval,
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
  return `${BEGIN}
# Written by Agent Micro · use: codex --profile ${PROFILE}
sandbox_mode = "${cfg.sandbox_mode}"
approval_policy = "${cfg.approval_policy}"
agents.job_max_runtime_seconds = ${cfg.job_max_runtime_seconds}

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
    `sandbox_mode="${cfg.sandbox_mode}"`,
    `approval_policy="${cfg.approval_policy}"`,
    `agents.job_max_runtime_seconds=${cfg.job_max_runtime_seconds}`,
    `features.network_proxy.enabled=${cfg.network_proxy}`,
  ];
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
    toml = upsertManagedBlock(toml, profileToml(next).trim());
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
    profile: PROFILE,
    profilePath: profilePath(),
    configPath: userConfigPath(),
  };
}

module.exports = {
  DEFAULTS,
  SANDBOX_MODES,
  APPROVAL_POLICIES,
  PROFILE,
  setUserDataPath,
  load,
  save,
  meta,
  cliConfigArgs,
  withCliFlags,
  writeCodexIgnore,
  CODEXIGNORE_SAMPLE,
};
