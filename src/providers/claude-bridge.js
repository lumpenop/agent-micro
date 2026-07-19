const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const mac = require('../platform/mac');
const { BaseBridge, REASONING, SKILLS, emptyAgent, demo, truncate, whichSync, openUrl } = require('./base-bridge');
const { t } = require('../i18n');
const padPrefs = require('../pad-prefs');

function lt(key, vars) {
  return t(padPrefs.getLocale(), key, vars);
}

/**
 * Find the claude binary.
 * Priority: 1) PATH → 2) bundled @anthropic-ai/claude-code package
 * Returns a path string, or {type:'node', path:<cli.mjs>} for JS entry, or null.
 */
function findClaudeBin() {
  // 1. Prefer `claude` on PATH (user-installed via npm i -g, Homebrew, etc.)
  const pathBin = whichSync('claude');
  if (pathBin) return pathBin;

  // 2. Look for bundled native binary inside @anthropic-ai/claude-code
  const roots = [path.join(__dirname, '..', '..', 'node_modules')];
  if (process.resourcesPath) {
    roots.unshift(
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    );
  }

  // 2a. Native binary: node_modules/@anthropic-ai/claude-code/bin/claude
  for (const root of roots) {
    const native = path.join(root, '@anthropic-ai', 'claude-code', 'bin', 'claude');
    if (fs.existsSync(native)) return native;
    // Some versions name it claude.exe on all platforms (observed on macOS 2.1.x)
    const nativeExe = path.join(root, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(nativeExe)) return nativeExe;
  }

  // 2b. Platform-specific native package (e.g. @anthropic-ai/claude-code-darwin-arm64)
  const PLATFORM_PKG = {
    'darwin-arm64': '@anthropic-ai/claude-code-darwin-arm64',
    'darwin-x64': '@anthropic-ai/claude-code-darwin-x64',
    'linux-x64': '@anthropic-ai/claude-code-linux-x64',
    'linux-arm64': '@anthropic-ai/claude-code-linux-arm64',
    'win32-x64': '@anthropic-ai/claude-code-win32-x64',
    'win32-arm64': '@anthropic-ai/claude-code-win32-arm64',
  };
  const key = `${process.platform}-${process.arch}`;
  const pkgName = PLATFORM_PKG[key];
  if (pkgName) {
    for (const root of roots) {
      const platformNative = path.join(root, pkgName, 'bin', 'claude');
      if (fs.existsSync(platformNative)) return platformNative;
      // Some versions name it claude.exe on all platforms
      const platformNativeExe = path.join(root, pkgName, 'bin', 'claude.exe');
      if (fs.existsSync(platformNativeExe)) return platformNativeExe;
    }
  }

  // 2c. JS entry point fallback: require cli.mjs and run with node
  try {
    const cliJs = require.resolve('@anthropic-ai/claude-code/cli.mjs');
    if (fs.existsSync(cliJs)) return { type: 'node', path: cliJs };
  } catch {
    /* not bundled */
  }
  for (const root of roots) {
    const cliJs = path.join(root, '@anthropic-ai', 'claude-code', 'cli.mjs');
    if (fs.existsSync(cliJs)) return { type: 'node', path: cliJs };
  }

  return null;
}

/** Spawn claude with proper arguments depending on binary type. */
function spawnClaude(bin, args, opts = {}) {
  if (typeof bin === 'object' && bin.type === 'node') {
    return spawn(process.execPath, [bin.path, ...args], {
      ...opts,
      env: { ...process.env, ...(opts.env || {}) },
    });
  }
  return spawn(bin, args, {
    ...opts,
    env: { ...process.env, ...(opts.env || {}) },
  });
}

class ClaudeBridge extends BaseBridge {
  constructor() {
    super('claude');
    this.linkMode = 'cli';
    this._loggedIn = null;
    this.selected = 0;
    this.agents = Array.from({ length: 6 }, () => emptyAgent());
    this.reasoningIndex = 2;
    this.fastMode = false;
    this.planMode = false;
  }

  getState() {
    return {
      provider: this.provider,
      connected: this.connected,
      mode: this.mode,
      linkMode: this.linkMode,
      selected: this.selected,
      reasoning: REASONING[this.reasoningIndex],
      reasoningIndex: this.reasoningIndex,
      fastMode: this.fastMode,
      planMode: this.planMode,
      agents: this.agents.map((a) => ({ ...a })),
      canFork: false,
    };
  }

  getLinkInfo() {
    return {
      provider: this.provider,
      hasCodex: false,
      hasBinary: !!findClaudeBin(),
      connected: this.connected,
      mode: this.mode,
      linkMode: this.linkMode,
      loggedIn: this._loggedIn ?? null,
    };
  }

  /** Run `claude login status` to check if logged in. */
  async checkLogin() {
    const bin = findClaudeBin();
    if (!bin) {
      this._loggedIn = false;
      return { hasCodex: false, hasBinary: false, loggedIn: false };
    }
    try {
      const out = await this._runClaude(['login', 'status'], 8000);
      const detail = out.trim();
      const stale =
        /access token could not be refreshed|logged out|sign in again|not logged in|unauthorized|not authenticated/i.test(
          detail
        );
      const loggedIn = !stale && /logged in|authenticated/i.test(detail);
      this._loggedIn = loggedIn;
      return { hasCodex: false, hasBinary: true, loggedIn, stale, detail };
    } catch (err) {
      const detail = String(err.message || '');
      const stale =
        /access token could not be refreshed|logged out|sign in again|unauthorized|not authenticated/i.test(detail);
      this._loggedIn = false;
      return { hasCodex: false, hasBinary: true, loggedIn: false, stale, detail };
    }
  }

  /** Opens Claude Code login in the browser, then reports status. */
  async login() {
    const bin = findClaudeBin();
    if (!bin) {
      this.emitState(lt('bridge.missingInstall'));
      return { ok: false, reason: 'missing' };
    }
    this.emitState(lt('bridge.loginBrowser'));
    this.emit('log', 'Opening Claude login…');
    try {
      await this._runClaude(['login'], 180000);
    } catch (err) {
      this.emit('log', `login: ${err.message}`);
    }
    const status = await this.checkLogin();
    if (!status.loggedIn) {
      this.emitState(lt('bridge.loginNeeded'));
      return { ok: false, reason: 'not-logged-in', ...status };
    }
    this.emitState(lt('bridge.loggedIn'));
    return { ok: true, ...status };
  }

  /** Connect: ensure logged in, then mark as connected (CLI mode). */
  async connect({ forceLogin = false } = {}) {
    const bin = findClaudeBin();
    if (!bin) {
      this._seedDemo();
      this.emitState(lt('bridge.missing'));
      return { ok: false, reason: 'missing', linkMode: 'cli' };
    }

    const status = await this.checkLogin();
    if (forceLogin || !status.loggedIn) {
      const loginResult = await this.login();
      if (!loginResult.ok) return { ok: false, reason: 'login', linkMode: 'cli', ...loginResult };
    }

    this.connected = true;
    this.mode = 'cli';
    // Clear demo placeholders
    this.agents = this.agents.map((a) =>
      !a || a.status === 'off' || String(a.threadId || '').startsWith('demo')
        ? emptyAgent()
        : a
    );
    if (this.agents[this.selected]?.status === 'off') {
      const live = this.agents.findIndex((a) => a.status !== 'off');
      this.selected = live >= 0 ? live : 0;
    }
    this.emitState(lt('bridge.connected'));
    return {
      ok: true,
      reason: 'connected',
      loggedIn: true,
      linkMode: 'cli',
    };
  }

  start() {
    // Claude doesn't have an app-server; just mark connected
    this._seedDemo();
    this.emitState(lt('bridge.notFoundDemo'));
    return false;
  }

  stop() {
    this.connected = false;
    this.mode = 'offline';
  }

  /** Build the claude CLI launch command for terminal. */
  _claudeCliCommand() {
    const bin = findClaudeBin();
    if (!bin) return 'claude';
    let base;
    if (typeof bin === 'object' && bin.type === 'node') {
      // JS entry: run with node
      const node = process.execPath.replace(/'/g, `'\\''`);
      const script = String(bin.path).replace(/'/g, `'\\''`);
      base = `'${node}' '${script}'`;
    } else {
      base = `'${String(bin).replace(/'/g, `'\\''`)}'`;
    }
    let workingDirectory = '';
    try {
      const { withCliFlags, load } = require('../codex-settings');
      base = withCliFlags(base);
      const configured = load().working_directory;
      if (configured && fs.existsSync(configured) && fs.statSync(configured).isDirectory()) {
        workingDirectory = configured;
      }
    } catch {
      /* keep base */
    }
    return workingDirectory
      ? `cd '${workingDirectory.replace(/'/g, `'\\''`)}' && ${base}`
      : base;
  }

  _configuredWorkingDirectory() {
    try {
      const configured = require('../codex-settings').load().working_directory;
      if (configured && fs.existsSync(configured) && fs.statSync(configured).isDirectory()) return configured;
    } catch {}
    return process.env.HOME || process.cwd();
  }

  _projectName(cwd) {
    const folder = String(cwd || '').trim();
    if (!folder) return '—';
    try {
      const manifest = path.join(folder, 'package.json');
      if (fs.existsSync(manifest)) {
        const name = JSON.parse(fs.readFileSync(manifest, 'utf8'))?.name;
        if (name) return String(name);
      }
    } catch {}
    return path.basename(folder) || folder;
  }

  /** Run claude with args and return stdout. Handles both native and node types. */
  _runClaude(args, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const bin = findClaudeBin();
      if (!bin) return reject(new Error('Claude CLI not found'));
      const child = spawnClaude(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error(`timeout: claude ${args.join(' ')}`));
      }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const text = `${out}\n${err}`.trim();
        if (code === 0 || /logged in|authenticated/i.test(text)) resolve(text);
        else reject(new Error(text || `exit ${code}`));
      });
    });
  }

  async select(index, { focus = false } = {}) {
    const requested = Math.max(0, Math.min(5, index));
    let slot = requested;
    try {
      const r = await this.ensureAgentCliWindow(requested, { focus: true });
      if (r?.mode === 'blocked') {
        this.emitState(r.error || lt('bridge.order'));
        return { ok: false, reason: r.reason || 'blocked', slot: requested };
      }
      if (typeof r?.slot === 'number') slot = r.slot;
      this.selected = slot;
      const a = this.agents[this.selected];
      if (a.status === 'complete') a.status = 'idle';
      if (a.status === 'off') {
        a.status = 'idle';
        if (!a.name || a.name === '—') a.name = `Agent ${slot + 1}`;
        a.cwd = this._configuredWorkingDirectory();
        a.projectName = this._projectName(a.cwd);
      }
      this.connected = true;
      this.mode = 'cli';
      if (r?.opened && r.mode === 'window') {
        this.emitState(lt('bridge.window', { n: slot + 1 }));
      } else if (r?.opened && (r.mode === 'split' || r.mode === 'tab')) {
        this.emitState(lt('bridge.split', { n: slot + 1 }));
      } else if (r?.focused) {
        this.emitState(lt('bridge.focus', { n: slot + 1 }));
      } else {
        this.emitState(lt('bridge.switch', { n: slot + 1 }));
      }
      return { ok: true, slot };
    } catch (e) {
      this.emit('log', e?.message || String(e));
      this.emitState(lt('bridge.windowFail', { err: e?.message || e }));
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async ensureAgentCliWindow(slot, opts = {}) {
    if (process.platform !== 'darwin') {
      return { ok: false, error: 'macOS only' };
    }
    return mac.ensureCodexCliWindow(slot, {
      focus: opts.focus !== false,
      command: opts.command || this._claudeCliCommand(),
    });
  }

  async send(text) {
    const prompt = text || 'Continue.';
    const slot = this.selected;
    const a = this.agents[slot];
    try {
      const focus = await this.ensureAgentCliWindow(slot, { focus: true });
      if (!focus?.ok) {
        const hint = focus?.error || focus?.reason || lt('bridge.dictationFail');
        this.emitState(hint);
        if (a) a.status = 'error';
        return { ok: false, code: 'NO_CLI', slot };
      }
      await mac.submitToCli(slot, prompt);
      if (a) {
        a.status = 'thinking';
        a.name = truncate(prompt, 42);
      }
      this.emitState(lt('bridge.sentCli'));
      return { ok: true, slot, mode: 'cli' };
    } catch (e) {
      if (a) a.status = 'error';
      this.emit('log', `send cli: ${e.message}`);
      this.emitState(e.code === 'NO_CLI' ? e.message : lt('bridge.sendFail', { err: e.message }));
      return { ok: false, error: e.message, slot };
    }
  }

  async approve() {
    const slot = this.selected;
    const a = this.agents[slot];
    try {
      const focus = await this.ensureAgentCliWindow(slot, { focus: true });
      if (!focus?.ok) {
        this.emitState(focus?.error || focus?.reason || lt('bridge.dictationFail'));
        return { ok: false, code: 'NO_CLI', slot };
      }
      await mac.cliApprove(slot);
      if (a?.approvalId) {
        this.approvals?.delete(a.approvalId);
        a.approvalId = null;
      }
      if (a) a.status = 'thinking';
      this.emitState(lt('bridge.approved'));
      return { ok: true, slot, mode: 'cli' };
    } catch (e) {
      this.emit('log', `approve cli: ${e.message}`);
      this.emitState(e.code === 'NO_CLI' ? e.message : lt('bridge.sendFail', { err: e.message }));
      return { ok: false, error: e.message, slot };
    }
  }

  async decline() {
    const slot = this.selected;
    const a = this.agents[slot];
    try {
      const focus = await this.ensureAgentCliWindow(slot, { focus: true });
      if (!focus?.ok) {
        this.emitState(focus?.error || focus?.reason || lt('bridge.dictationFail'));
        return { ok: false, code: 'NO_CLI', slot };
      }
      await mac.cliDecline(slot);
      if (a?.approvalId) {
        this.approvals?.delete(a.approvalId);
        a.approvalId = null;
      }
      if (a) a.status = 'idle';
      this.emitState(lt('bridge.declined'));
      return { ok: true, slot, mode: 'cli' };
    } catch (e) {
      this.emit('log', `decline cli: ${e.message}`);
      this.emitState(e.code === 'NO_CLI' ? e.message : lt('bridge.sendFail', { err: e.message }));
      return { ok: false, error: e.message, slot };
    }
  }

  async newChat() {
    const empty = this.agents.findIndex((a) => a.status === 'off');
    const slot = empty === -1 ? this.selected : empty;
    this.selected = slot;
    this.agents[slot] = {
      name: 'New task', status: 'idle', cwd: this._configuredWorkingDirectory(), threadId: null, turnId: null, approvalId: null,
    };
    try {
      await this.ensureAgentCliWindow(slot, { focus: true });
    } catch (e) {
      this.emit('log', `newChat cli: ${e.message}`);
    }
    this.emitState(lt('bridge.newChatDemo', { n: slot + 1 }));
    return { ok: true, slot, mode: 'cli' };
  }

  async prepareVoiceDictation() {
    const slot = this.selected;
    try {
      const login = await this.checkLogin();
      if (!login.hasBinary) {
        const hint = lt('bridge.missingInstall');
        this.emitState(hint);
        return { ok: false, error: hint, code: 'MISSING', slot };
      }
      if (!login.loggedIn) {
        const hint = login.stale ? lt('bridge.authStale') : lt('bridge.loginNeeded');
        this.emitState(hint);
        return { ok: false, error: hint, code: 'AUTH', stale: !!login.stale, slot };
      }
      const cli = await this.ensureAgentCliWindow(slot, { focus: false });
      if (!cli?.ok) {
        const hint = cli?.error || cli?.reason || lt('bridge.dictationFail');
        this.emitState(hint);
        return { ok: false, error: hint, code: cli?.reason || 'NO_CLI', slot };
      }
      return { ok: true, slot, opened: !!cli.opened };
    } catch (e) {
      this.emit('log', e.message);
      const hint =
        e.code === 'NO_CODEX_APP' || e.code === 'WRONG_APP' || e.code === 'NO_CLI'
          ? e.message
          : lt('bridge.dictationFail');
      this.emitState(hint);
      return { ok: false, error: hint, code: e.code || 'DICTATION', slot };
    }
  }

  async beginVoiceDictation() {
    const slot = this.selected;
    try {
      await mac.triggerDictation('start');
      this.emitState(lt('bridge.speak'));
      return { ok: true, mode: 'pad-sink', slot };
    } catch (e) {
      this.emit('log', e.message);
      const hint = lt('bridge.dictationFail');
      this.emitState(hint);
      return { ok: false, error: hint, code: e.code || 'DICTATION', slot };
    }
  }

  async endVoiceDictation() {
    const slot = this.selected;
    try {
      await mac.triggerDictation('stop');
      await new Promise((r) => setTimeout(r, 420));
      return { ok: true, slot, mode: 'pad-sink' };
    } catch (e) {
      this.emit('log', e.message);
      return { ok: false, error: e.message, slot };
    }
  }

  async submitVoiceText(text) {
    const slot = this.selected;
    const body = String(text || '').trim();
    if (!body) {
      this.emitState(lt('bridge.emptyVoice'));
      return { ok: false, reason: 'empty', slot };
    }
    try {
      await mac.submitToCli(slot, body);
      this.emitState(lt('bridge.sent'));
      return { ok: true, slot, mode: 'cli-paste' };
    } catch (e) {
      this.emit('log', e.message);
      this.emitState(lt('bridge.submitFail'));
      return { ok: false, error: e.message, slot };
    }
  }

  async voiceToCodex(text) {
    const body = String(text || '').trim();
    if (!body) {
      this.emitState(lt('bridge.emptyVoice'));
      return { ok: false, reason: 'empty' };
    }
    try {
      await this.send(body);
      this.emitState(lt('bridge.voiceCli'));
      return { ok: true, mode: 'cli' };
    } catch (e) {
      this.emit('log', `voice cli: ${e.message}`);
      this.emitState(lt('bridge.voiceFail'));
      return { ok: false, error: e.message };
    }
  }

  async desktopAction(action) {
    switch (action) {
      case 'agentPrev':
        this.select((this.selected - 1 + 6) % 6);
        return { ok: true, action };
      case 'agentNext':
        this.select((this.selected + 1) % 6);
        return { ok: true, action };
      case 'historyBack':
      case 'historyForward':
      case 'sidebar':
      case 'composer':
      case 'newDesktopChat':
        try {
          const r = await mac.desktopShortcut(action === 'newDesktopChat' ? 'newChat' : action);
          this.emitState(r?.label || action);
          return r;
        } catch (e) {
          this.emit('log', `desktop ${action}: ${e.message}`);
          this.emitState(lt('bridge.unknown', { action }));
          return { ok: false, reason: e.message };
        }
      default:
        this.emitState(lt('bridge.unknown', { action }));
        return { ok: false, reason: 'unknown' };
    }
  }

  setReasoning(index) {
    this.reasoningIndex = Math.max(0, Math.min(REASONING.length - 1, index));
    const value = REASONING[this.reasoningIndex];
    this.emitState(lt('bridge.reasoning', { value }));
    return value;
  }

  async toggleFast() {
    this.fastMode = !this.fastMode;
    if (this.fastMode) this.setReasoning(0);
    else if (this.reasoningIndex === 0) this.setReasoning(2);
    this.emitState(this.fastMode ? lt('bridge.fastOn') : lt('bridge.fastOff'));
    return this.fastMode;
  }

  async togglePlan() {
    this.planMode = !this.planMode;
    this.emitState(this.planMode ? lt('bridge.planOn') : lt('bridge.planOff'));
    return this.planMode;
  }

  async skill(name) {
    const text = SKILLS[name] || SKILLS.continue;
    await this.send(text);
    this.emitState(lt('bridge.skill', { name }));
  }

  async openModelPicker() {
    const slot = this.selected;
    const agent = this.agents[slot];
    if (agent?.status === 'thinking' || agent?.status === 'working') {
      return { ok: false, busy: true, error: 'Wait for the current response to finish before changing models' };
    }
    try {
      const focus = await this.ensureAgentCliWindow(slot, { focus: true });
      if (!focus?.ok) return { ok: false, error: focus?.error || focus?.reason || 'Claude CLI unavailable', slot };
      await mac.submitToCli(slot, '/model');
      this.emitState('Claude · model picker');
      return { ok: true, slot, mode: 'cli' };
    } catch (error) {
      this.emit('log', `model picker cli: ${error.message}`);
      return { ok: false, error: error.message, slot };
    }
  }

  async switchModel(rawModel) {
    const model = String(rawModel || '').trim();
    if (!/^[a-z][a-z0-9.-]+$/.test(model)) return { ok: false, error: 'Invalid model name' };
    const slot = this.selected;
    const agent = this.agents[slot];
    if (agent?.status === 'thinking' || agent?.status === 'working') {
      return { ok: false, busy: true, error: 'Wait for the current response to finish before changing models' };
    }
    try {
      const focus = await this.ensureAgentCliWindow(slot, { focus: true });
      if (!focus?.ok) return { ok: false, error: focus?.error || focus?.reason || 'Claude CLI unavailable', slot };
      await mac.submitToCli(slot, `/model ${model}`);
      if (agent) agent.model = model;
      this.emitState(`Claude · ${model}`);
      return { ok: true, slot, model, mode: 'cli' };
    } catch (error) {
      this.emit('log', `model switch cli: ${error.message}`);
      return { ok: false, error: error.message, slot };
    }
  }

  async fork() {
    this.emitState('fork not supported');
    return { ok: false, reason: 'unsupported' };
  }

  _activeCount() {
    return this.agents.filter((a) => a && a.status !== 'off').length;
  }

  async refreshThreads() {
    // No app-server — no-op
  }

  async listMcpServers() {
    return { ok: false, error: 'MCP not supported for Claude', servers: [] };
  }

  async mcpCommand(action, payload) {
    return { ok: false, error: 'MCP not supported for Claude' };
  }

  async listPlugins() {
    return { ok: false, error: 'Plugins not supported for Claude', plugins: [] };
  }
}

module.exports = { ClaudeBridge, findClaudeBin };
