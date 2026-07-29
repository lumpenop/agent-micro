const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const REASONING = ['minimal', 'low', 'medium', 'high', 'xhigh'];

const SKILLS = {
  review: 'Review the current changes / open PR. Summarize risks, bugs, and suggested fixes.',
  debug: 'Debug the latest error. Identify root cause and propose a concrete fix.',
  refactor: 'Refactor the relevant code for clarity and maintainability without changing behavior.',
  docs: 'Write or update documentation for the current work. Be concise and accurate.',
  continue: 'Continue.',
  ship: 'Prepare this work to ship: check tests, summarize the diff, and list remaining risks.',
  test: 'Add or run relevant tests for the current change. Report failures with fixes.',
  explain: 'Explain the current code path simply: what it does, why, and key risks.',
};

function emptyAgent() {
  return { name: '—', status: 'off', cwd: null, threadId: null, turnId: null, approvalId: null };
}

function demo(name, status, approvalId = null) {
  return {
    name,
    status,
    threadId: `demo-${name}`,
    turnId: null,
    approvalId,
    cwd: null,
  };
}

function truncate(s, n) {
  const str = String(s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

/** Shared AgentBridge state + unsupported-op stubs. */
class BaseBridge extends EventEmitter {
  constructor(providerId) {
    super();
    this.provider = providerId;
    this.connected = false;
    this.mode = 'offline';
    this.agents = Array.from({ length: 6 }, () => emptyAgent());
    this.selected = 0;
    this.reasoningIndex = 2;
    this.fastMode = false;
    this.planMode = false;
    this._loggedIn = null;
  }

  getState() {
    return {
      provider: this.provider,
      connected: this.connected,
      mode: this.mode,
      selected: this.selected,
      reasoning: REASONING[this.reasoningIndex],
      reasoningIndex: this.reasoningIndex,
      fastMode: this.fastMode,
      planMode: this.planMode,
      agents: this.agents.map((a) => ({ ...a })),
    };
  }

  getLinkInfo() {
    return {
      provider: this.provider,
      hasCodex: this.provider === 'codex',
      hasBinary: null,
      connected: this.connected,
      mode: this.mode,
      loggedIn: this._loggedIn ?? null,
    };
  }

  emitState(action) {
    this.emit('state', { ...this.getState(), action });
  }

  _seedDemo() {
    this.agents = [
      demo('Refactor auth flow', 'thinking'),
      demo('Fix flaky CI', 'idle'),
      demo('PR review #4821', 'input', 'demo-appr'),
      demo('Write migration', 'complete'),
      demo('Debug race condition', 'error'),
      demo('Docs pass', 'idle'),
    ];
    this.mode = 'offline';
    this.connected = false;
  }

  select(index, { focus = false } = {}) {
    if (index < 0 || index >= this.agents.length) return;
    this.selected = index;
    const a = this.agents[index];
    if (typeof a?.fastMode === 'boolean') this.fastMode = a.fastMode;
    if (a.status === 'off' && this.connected) {
      a.status = 'idle';
      a.name = a.name === '—' ? `Agent ${index + 1}` : a.name;
    }
    if (focus) this.focusApp?.();
    this.emitState(focus ? `focus · Agent ${index + 1}` : `switch · Agent ${index + 1}`);
  }

  async setReasoning(index) {
    this.reasoningIndex = Math.max(0, Math.min(REASONING.length - 1, index));
    this.emitState(`reasoning · ${REASONING[this.reasoningIndex]}`);
  }

  async toggleFast() {
    this.fastMode = !this.fastMode;
    if (this.fastMode) {
      this.reasoningIndex = 0;
    }
    this.emitState(this.fastMode ? 'fast mode on' : 'fast mode off');
  }

  async togglePlan() {
    this.planMode = !this.planMode;
    this.emitState(this.planMode ? 'plan mode on' : 'plan mode off');
  }

  async skill(name) {
    const text = SKILLS[name] || SKILLS.continue;
    const result = await this.send(text);
    this.emitState(`skill · ${name}`);
    return result;
  }

  async approve() {
    this.emitState('approve not supported');
  }

  async decline() {
    this.emitState('decline not supported');
  }

  async fork() {
    this.emitState('fork not supported');
  }

  async desktopAction(action) {
    this.emitState(`desktop · ${action}`);
  }

  focusApp() {
    /* override per provider */
  }

  async checkLogin() {
    return { hasBinary: false, loggedIn: false };
  }

  async login() {
    this.emitState('login not configured');
    return { ok: false, reason: 'unsupported' };
  }

  async readRateLimits() {
    return null;
  }

  async connect(opts = {}) {
    const status = await this.checkLogin();
    if (opts.forceLogin || !status.loggedIn) {
      const login = await this.login();
      if (!login.ok && login.reason !== 'already') {
        return { ok: false, reason: 'login', ...login };
      }
    }
    this.stop();
    const started = await this.start();
    return { ok: started, reason: started ? 'connected' : 'offline', loggedIn: !!status.loggedIn };
  }

  start() {
    return Promise.resolve(false);
  }

  stop() {
    this.connected = false;
  }
}

function whichSync(cmd) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(cmd || ''))) return null;
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return String(out).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
  } catch {}
  if (process.platform !== 'win32') {
    const home = os.homedir();
    const directories = [
      ...(process.env.PATH || '').split(path.delimiter),
      '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
      path.join(home, '.local', 'bin'), path.join(home, 'Library', 'pnpm'),
      path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'),
      path.join(home, '.volta', 'bin'),
    ];
    for (const directory of [...new Set(directories.filter(Boolean))]) {
      const candidate = path.join(directory, cmd);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
    }
    // GUI apps do not inherit shell startup PATH. Ask the user's login shell as
    // a final fallback so nvm/asdf/custom profile installations are reusable.
    try {
      const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
      const out = execFileSync(shell, ['-ilc', `command -v ${cmd}`], { encoding: 'utf8', timeout: 5000 });
      const candidate = String(out).split(/\r?\n/).map((line) => line.trim()).find((line) => path.isAbsolute(line));
      if (candidate) { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    } catch {}
  }
  return null;
}

function openUrl(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], () => {});
  } else {
    execFile(opener, [url], () => {});
  }
}

module.exports = {
  BaseBridge,
  REASONING,
  SKILLS,
  emptyAgent,
  demo,
  truncate,
  whichSync,
  openUrl,
};
