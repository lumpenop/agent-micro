const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const EventEmitter = require('events');
const mac = require('../platform/mac');
const { REASONING, SKILLS, emptyAgent, demo, truncate } = require('./base-bridge');
const { t } = require('../i18n');
const padPrefs = require('../pad-prefs');
const { detectActiveProject, detectProjectFromRollout } = require('../agent-project-context');

function lt(key, vars) {
  return t(padPrefs.getLocale(), key, vars);
}

// Rollout logs are the reliable source when a model is changed through the
// visible CLI picker (that change is not always echoed by app-server).
const rolloutModelCache = new Map();

function readRolloutModel(file) {
  if (!file) return { model: '', reasoning: '', changed: false };
  let stat;
  try { stat = fs.statSync(file); } catch { return { model: '', changed: false }; }
  const cached = rolloutModelCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { model: cached.model, reasoning: cached.reasoning, changed: false };
  }

  let model = '';
  let reasoning = '';
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.includes('thread_settings_applied') && !line.includes('"model"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const payload = row?.payload || {};
      const settings = payload.thread_settings || payload.threadSettings || {};
      const candidate = settings.model || (payload.type === 'turn_context' ? payload.model : '') || payload.model || '';
      const effort = settings.reasoning_effort || payload.reasoning_effort || '';
      if (typeof candidate === 'string' && candidate.trim()) model = candidate.trim();
      if (typeof effort === 'string' && REASONING.includes(effort.trim())) reasoning = effort.trim();
    }
  } catch {
    model = cached?.model || '';
    reasoning = cached?.reasoning || '';
  }
  rolloutModelCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, model, reasoning });
  return { model, reasoning, changed: true };
}

function parsePluginListOutput(output) {
  const text = String(output || '').trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('Codex plugin list did not return a JSON object');
    parsed = JSON.parse(text.slice(start, end + 1));
  }
  if (Array.isArray(parsed)) return parsed;
  return Array.isArray(parsed?.installed) ? parsed.installed : [];
}

const PLATFORM_BIN = {
  'darwin-arm64': {
    pkg: '@openai/codex-darwin-arm64',
    parts: ['vendor', 'aarch64-apple-darwin', 'bin', 'codex'],
  },
  'darwin-x64': {
    pkg: '@openai/codex-darwin-x64',
    parts: ['vendor', 'x86_64-apple-darwin', 'bin', 'codex'],
  },
  'linux-x64': {
    pkg: '@openai/codex-linux-x64',
    parts: ['vendor', 'x86_64-unknown-linux-musl', 'bin', 'codex'],
  },
  'linux-arm64': {
    pkg: '@openai/codex-linux-arm64',
    parts: ['vendor', 'aarch64-unknown-linux-musl', 'bin', 'codex'],
  },
  'win32-x64': {
    pkg: '@openai/codex-win32-x64',
    parts: ['vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'],
  },
  'win32-arm64': {
    pkg: '@openai/codex-win32-arm64',
    parts: ['vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe'],
  },
};

const { whichSync } = require('./base-bridge');

function nativeFromCodexEntrypoint(entrypoint) {
  const key = `${process.platform}-${process.arch}`;
  const spec = PLATFORM_BIN[key];
  if (!spec || !entrypoint) return null;

  let real;
  try { real = fs.realpathSync(entrypoint); } catch { real = entrypoint; }
  if (!/[/\\]codex[/\\]bin[/\\]codex\.js$/.test(real)) return null;

  const packageRoot = path.dirname(path.dirname(real));
  const candidate = path.join(packageRoot, 'node_modules', '@openai', path.basename(spec.pkg), ...spec.parts);
  return fs.existsSync(candidate) ? candidate : null;
}

function findCodexNative() {
  // 1. Prefer the native binary belonging to a PATH-installed JS launcher.
  // Running the JS wrapper from an Electron-launched Terminal can lose pnpm's
  // module resolution and incorrectly print “pnpm add -g @openai/codex”.
  const pathBin = whichSync('codex');
  const pathNative = nativeFromCodexEntrypoint(pathBin);
  if (pathNative) return pathNative;

  // 2. Agent Micro's on-demand installation.
  const managedBin = process.env.AGENT_MICRO_CODEX_BIN;
  if (managedBin && fs.existsSync(managedBin)) return managedBin;

  // 3. A native binary already available on PATH (Homebrew, standalone, …).
  if (pathBin) return pathBin;

  // 4. Development fallback from @openai/codex.
  const key = `${process.platform}-${process.arch}`;
  const spec = PLATFORM_BIN[key];
  const roots = [path.join(__dirname, '..', '..', 'node_modules', '@openai')];
  // electron-builder unpacks native executables next to app.asar. A path inside
  // app.asar cannot be passed to spawn(), so prefer the real unpacked resource.
  if (process.resourcesPath) {
    roots.unshift(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@openai'));
  }

  if (spec) {
    for (const root of roots) {
      const hoisted = path.join(root, path.basename(spec.pkg), ...spec.parts);
      if (fs.existsSync(hoisted)) return hoisted;
    }
    try {
      const pkgJson = require.resolve(`${spec.pkg}/package.json`);
      const resolved = path.join(path.dirname(pkgJson), ...spec.parts);
      if (fs.existsSync(resolved)) return resolved;
    } catch {
      /* optional platform package missing */
    }
  }

  try {
    const js = require.resolve('@openai/codex/bin/codex.js');
    if (fs.existsSync(js)) return { type: 'node', path: js };
  } catch {
    /* fall through */
  }

  for (const root of roots) {
    const js = path.join(root, 'codex', 'bin', 'codex.js');
    if (fs.existsSync(js)) return { type: 'node', path: js };
  }
  return null;
}

function spawnCodex(bin, args, opts = {}) {
  // When the native binary is launched directly from a package-manager
  // install, Codex cannot infer its package root and may run its first-run
  // PATH/update repair flow on every app start. Pass the package metadata
  // explicitly so an already-installed CLI is treated as authoritative.
  const managedEnv = {};
  if (typeof bin === 'string') {
    const marker = `${path.sep}node_modules${path.sep}@openai${path.sep}codex${path.sep}`;
    const markerIndex = bin.indexOf(marker);
    if (markerIndex >= 0) {
      managedEnv.CODEX_MANAGED_BY_PNPM = '1';
      managedEnv.CODEX_MANAGED_PACKAGE_ROOT = bin.slice(0, markerIndex + marker.length - 1);
    }
  }
  if (typeof bin === 'object' && bin.type === 'node') {
    return spawn(process.execPath, [bin.path, ...args], {
      ...opts,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...managedEnv, ...(opts.env || {}) },
    });
  }
  return spawn(bin, args, {
    ...opts,
    env: { ...process.env, ...managedEnv, ...(opts.env || {}) },
  });
}

class CodexBridge extends EventEmitter {
  constructor({ customProvider = false } = {}) {
    super();
    this.customProvider = !!customProvider;
    this.provider = this.customProvider ? 'api' : 'codex';
    /** @type {'cli'} */
    this.linkMode = 'cli';
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connected = false;
    this.mode = 'offline';
    this.agents = Array.from({ length: 6 }, () => emptyAgent());
    this.selected = 0;
    this.reasoningIndex = 2;
    this.fastMode = false;
    this.planMode = false;
    this.approvals = new Map();
    this._poll = null;
    this._contextPoll = null;
    this._rolloutWatchers = new Map();
    this._rolloutWatchTimers = new Map();
    this._modelPickerPending = null;
    this._pendingRouting = new Map();
    this._refreshThreadsPending = null;
    this._refreshContextsPending = null;
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
      canFork: this._canFork(),
    };
  }

  /** How many agent slots are live (not off). */
  _activeCount() {
    return this.agents.filter((a) => a && a.status !== 'off').length;
  }

  /** First empty agent slot (status off), or -1 if all 6 are in use. */
  _nextForkSlot() {
    return this.agents.findIndex((a) => !a || a.status === 'off');
  }

  /** UI: gray out only when all 6 slots are live. */
  _canFork() {
    return this._nextForkSlot() >= 0;
  }

  /**
   * Fork current thread into the next empty slot, open/focus its CLI split.
   * Prefer a disk-backed session (CLI rollout). App-server thread/fork alone
   * often fails with "no rollout found" when the slot id is a phantom
   * thread/start id that never wrote a rollout.
   */
  async fork() {
    const active = this._activeCount();
    if (active < 1) {
      this.emitState(lt('bridge.forkNoSource'));
      return { ok: false, reason: 'no-source' };
    }
    if (active >= 6) {
      this.emitState(lt('bridge.forkFull'));
      return { ok: false, reason: 'full' };
    }

    const target = this._nextForkSlot();
    if (target < 0) {
      this.emitState(lt('bridge.forkFull'));
      return { ok: false, reason: 'full' };
    }

    const src = this.agents[this.selected];
    if (!src || src.status === 'off') {
      this.emitState(lt('bridge.forkSelect'));
      return { ok: false, reason: 'no-source' };
    }

    let threadId = src.threadId;
    let name = `${src.name || 'Agent'} · fork`;
    let status = 'idle';
    let launchCmd = null;

    if (!this.connected || String(threadId || '').startsWith('demo')) {
      // Demo / offline: copy slot state into empty agent
      name = `${src.name || 'Agent'} · continued`;
      status = 'thinking';
      threadId = src.threadId || `demo-fork-${Date.now()}`;
    } else {
      const sourceId = await this._resolveForkableThreadId(src);
      let forkedId = null;

      if (sourceId) {
        try {
          const result = await this.request('thread/fork', { threadId: sourceId });
          forkedId = result?.thread?.id || result?.threadId || result?.id || null;
        } catch (e) {
          if (!isNoRolloutError(e)) {
            this.emitState(lt('bridge.forkFail', { err: e.message }));
            return { ok: false, error: e.message };
          }
          this.emit('log', `fork app-server: ${e.message}; CLI fallback`);
        }
      }

      if (forkedId && shellQuoteId(forkedId)) {
        threadId = forkedId;
        // Resume the already-forked thread in the new pane
        launchCmd = this._codexSubcommand(`resume ${shellQuoteId(forkedId)}`, target);
      } else {
        // CLI reads ~/.codex/sessions rollouts directly (reliable path)
        const quoted = shellQuoteId(sourceId);
        launchCmd = quoted
          ? this._codexSubcommand(`fork ${quoted}`, target)
          : this._codexSubcommand('fork --last', target);
        threadId = quoted || `fork-pending-${Date.now()}`;
      }
    }

    const prevSelected = this.selected;
    this.agents[target] = {
      name,
      status,
      cwd: this._configuredWorkingDirectory(target),
      threadId,
      turnId: null,
      approvalId: null,
    };
    this.selected = target;

    // Always open/focus CLI split for the fork target (Agent N pane)
    const rollback = () => {
      this.agents[target] = emptyAgent();
      this.selected = prevSelected;
    };
    try {
      const cli = await this.ensureAgentCliWindow(target, {
        focus: true,
        command: launchCmd || undefined,
      });
      if (cli && cli.ok === false) {
        const err = cli.error || cli.reason || 'cli open failed';
        rollback();
        this.emit('log', `fork cli: ${err}`);
        this.emitState(lt('bridge.forkFail', { err }));
        return { ok: false, error: err, slot: target };
      }
    } catch (e) {
      rollback();
      this.emit('log', `fork cli: ${e.message}`);
      this.emitState(lt('bridge.forkFail', { err: e.message }));
      return { ok: false, error: e.message, slot: target };
    }

    this.emitState(lt('bridge.forkOk', { n: target + 1 }));
    return { ok: true, slot: target };
  }

  /**
   * Pick a session id that has a real rollout on disk (forkable).
   * Slot threadIds from thread/start are often missing rollouts.
   */
  async _resolveForkableThreadId(src) {
    const candidates = [];
    const slotId = src?.threadId;
    if (slotId && !String(slotId).startsWith('demo')) candidates.push(slotId);

    if (this.connected) {
      try {
        let result;
        try {
          result = await this.request('thread/list', { limit: 24 });
        } catch {
          result = await this.request('thread/list', {});
        }
        for (const t of normalizeThreads(result)) {
          if (t?.id && !candidates.includes(t.id)) candidates.push(t.id);
        }
      } catch {
        /* ignore */
      }
    }

    for (const id of candidates) {
      if (findRolloutPathForThread(id)) return id;
    }

    return findNewestRolloutThreadId();
  }

  emitState(action) {
    this.emit('state', { ...this.getState(), action });
  }

  getLinkInfo() {
    const bin = findCodexNative();
    return {
      provider: this.provider,
      hasCodex: !!bin,
      hasBinary: !!bin,
      connected: this.connected,
      mode: this.mode,
      linkMode: this.linkMode,
      loggedIn: this._loggedIn ?? null,
    };
  }

  async checkLogin() {
    const bin = findCodexNative();
    if (!bin) {
      this._loggedIn = false;
      return { hasCodex: false, loggedIn: false };
    }
    if (this.customProvider) {
      const settings = require('../codex-settings').load();
      const base = String(settings.api_base_url || '').trim();
      const model = String(settings.api_model || settings.model || '').trim();
      const envName = String(settings.api_key_env || 'OPENAI_API_KEY').trim();
      const hasKey = !!process.env[envName] || /^https?:\/\/localhost(?::|\/)/i.test(base);
      const configured = !!base && !!model && hasKey;
      this._loggedIn = configured;
      return {
        hasCodex: true,
        loggedIn: configured,
        customProvider: true,
        detail: configured ? 'Custom model provider configured' : 'Set API base URL, model, and API key environment variable',
      };
    }
    try {
      const out = await this._runCodex(bin, ['login', 'status'], 8000);
      const detail = out.trim();
      // Stale / switched ChatGPT session — status text may still look OK, or error in stdout
      const stale =
        /access token could not be refreshed|logged out|sign in again|not logged in|unauthorized/i.test(
          detail
        );
      const loggedIn = !stale && /logged in/i.test(detail);
      this._loggedIn = loggedIn;
      return { hasCodex: true, loggedIn, stale, detail };
    } catch (err) {
      const detail = String(err.message || '');
      const stale =
        /access token could not be refreshed|logged out|sign in again|unauthorized/i.test(detail);
      this._loggedIn = false;
      return { hasCodex: true, loggedIn: false, stale, detail };
    }
  }

  async listMcpServers() {
    const bin = findCodexNative();
    if (!bin) return { ok: false, error: 'Codex CLI missing', servers: [] };
    try {
      const output = await this._runCodex(bin, ['mcp', 'list', '--json'], 15000);
      const jsonStart = output.indexOf('[');
      const jsonEnd = output.lastIndexOf(']');
      const servers = JSON.parse(jsonStart >= 0 && jsonEnd >= jsonStart ? output.slice(jsonStart, jsonEnd + 1) : output);
      return { ok: true, servers: Array.isArray(servers) ? servers : [] };
    } catch (error) {
      return { ok: false, error: error.message, servers: [] };
    }
  }

  async readRateLimits() {
    if (!this.proc) return null;
    try {
      const result = await this.request('account/rateLimits/read');
      return result?.rateLimits || result?.rate_limits || result || null;
    } catch {
      return null;
    }
  }

  async mcpCommand(action, payload = {}) {
    const bin = findCodexNative();
    const name = String(payload.name || '');
    if (!bin) return { ok: false, error: 'Codex CLI missing' };
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) return { ok: false, error: 'Invalid MCP server name' };
    let args;
    if (action === 'add') {
      if (payload.type === 'http') {
        let parsed;
        try { parsed = new URL(String(payload.url || '')); } catch { return { ok: false, error: 'Invalid MCP URL' }; }
        if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'MCP URL must use http or https' };
        if (parsed.username || parsed.password) return { ok: false, error: 'MCP URL must not contain embedded credentials' };
        args = ['mcp', 'add', name, '--url', parsed.toString()];
        if (payload.bearer_token_env_var) {
          const envName = String(payload.bearer_token_env_var).trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(envName)) return { ok: false, error: 'Invalid bearer token environment variable' };
          args.push('--bearer-token-env-var', envName);
        }
      } else {
        const command = String(payload.command || '').trim();
        if (!command) return { ok: false, error: 'MCP command is required' };
        const commandArgs = Array.isArray(payload.args) ? payload.args.map(String).filter(Boolean).slice(0, 64) : [];
        args = ['mcp', 'add', name, '--', command, ...commandArgs];
      }
    } else if (['remove', 'login', 'logout', 'get'].includes(action)) {
      args = ['mcp', action, name];
      if (action === 'get') args.push('--json');
    } else return { ok: false, error: 'Unsupported MCP action' };
    try {
      const output = await this._runCodex(bin, args, action === 'login' ? 180000 : 20000);
      if (action === 'get') {
        const start = output.indexOf('{'); const end = output.lastIndexOf('}');
        return { ok: true, output: JSON.parse(output.slice(start, end + 1)) };
      }
      return { ok: true, output };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async listPlugins() {
    const bin = findCodexNative();
    if (!bin) return { ok: false, error: 'Codex CLI missing', plugins: [] };
    try {
      const output = await this._runCodex(bin, ['plugin', 'list', '--json'], 20000);
      return { ok: true, plugins: parsePluginListOutput(output) };
    } catch (error) { return { ok: false, error: error.message, plugins: [] }; }
  }

  /** Opens ChatGPT device login in the browser, then reports status. */
  async login() {
    if (this.customProvider) {
      const status = await this.checkLogin();
      return status.loggedIn ? { ok: true, ...status } : { ok: false, reason: 'config', ...status };
    }
    const bin = findCodexNative();
    if (!bin) {
      this.emitState(lt('bridge.missingInstall'));
      return { ok: false, reason: 'missing' };
    }
    this.emitState(lt('bridge.loginBrowser'));
    this.emit('log', 'Opening Codex login…');
    try {
      await this._runCodex(bin, ['login'], 180000);
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

  /** Connect via CLI app-server (stdio or proxy). */
  async connect({ forceLogin = false } = {}) {
    const bin = findCodexNative();
    if (!bin) {
      this._seedDemo();
      this.emitState(lt('bridge.missing'));
      return { ok: false, reason: 'missing', linkMode: 'cli' };
    }

    const status = await this.checkLogin();
    if (this.customProvider) {
      if (!status.loggedIn) {
        this.emitState(status.detail || 'Custom API configuration required');
        return { ok: false, reason: 'config', linkMode: 'cli', ...status };
      }
      this.stop();
      const started = await this.start();
      return { ok: started, reason: started ? 'connected' : 'offline', loggedIn: true, linkMode: 'cli', customProvider: true };
    }
    if (forceLogin || !status.loggedIn) {
      const login = await this.login();
      if (!login.ok) return { ok: false, reason: 'login', linkMode: 'cli', ...login };
    }

    this.stop();
    const started = await this.start();
    return {
      ok: started,
      reason: started ? 'connected' : 'offline',
      loggedIn: true,
      linkMode: 'cli',
    };
  }

  _runCodex(bin, args, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const child = spawnCodex(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => {
        out += d.toString();
      });
      child.stderr.on('data', (d) => {
        err += d.toString();
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        reject(new Error(`timeout: codex ${args.join(' ')}`));
      }, timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const text = `${out}\n${err}`.trim();
        if (code === 0 || /logged in/i.test(text)) resolve(text);
        else reject(new Error(text || `exit ${code}`));
      });
    });
  }

  async start() {
    const bin = findCodexNative();
    if (!bin) {
      this._seedDemo();
      this.emitState(lt('bridge.notFoundDemo'));
      return false;
    }

    try {
      await this._spawnServer(bin, ['app-server', '--stdio'], 'stdio');
    } catch (err) {
      this.emit('log', `stdio failed: ${err.message}`);
      try {
        await this._spawnServer(bin, ['app-server', 'proxy'], 'proxy');
      } catch (err2) {
        this.emit('log', `proxy failed: ${err2.message}`);
        this.connected = false;
        this.mode = 'offline';
        this._seedDemo();
        this.emitState(lt('bridge.offlineDemo'));
        return false;
      }
    }

    this.connected = true;
    // Clear demo placeholders only — keep live CLI agents across soft reconnect
    this.agents = this.agents.map((a) =>
      !a || a.status === 'off' || String(a.threadId || '').startsWith('demo')
        ? emptyAgent()
        : a
    );
    if (this.agents[this.selected]?.status === 'off') {
      const live = this.agents.findIndex((a) => a.status !== 'off');
      this.selected = live >= 0 ? live : 0;
    }
    await this.refreshThreads().catch((e) => this.emit('log', e.message));
    this.emitState(lt('bridge.connected'));
    // App-server notifications are the primary path; this reconciles external
    // terminal window lifecycle and historical thread state as a fallback.
    this._poll = setInterval(() => {
      this.refreshThreads().catch(() => {});
    }, 1000);
    // The visible CLI can change model/effort without producing an app-server
    // notification. Rollout files are the authoritative per-agent source for
    // those settings, so watch them frequently for external `/fast` changes.
    this._contextPoll = setInterval(() => {
      this.refreshAgentContexts().catch(() => {});
    }, 1000);
    return true;
  }

  _spawnServer(bin, args, mode) {
    return new Promise((resolve, reject) => {
      const child = spawnCodex(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      this.proc = child;
      this.mode = mode;
      this._attachIO();

      const onErr = (d) => this.emit('log', d.toString().trim());
      child.stderr.on('data', onErr);
      child.on('error', reject);

      const timer = setTimeout(() => {
        reject(new Error('handshake timeout'));
      }, 12000);

      this._handshake()
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((e) => {
          clearTimeout(timer);
          try {
            child.kill();
          } catch {}
          reject(e);
        });
    });
  }

  stop() {
    if (this._poll) {
      clearInterval(this._poll);
      this._poll = null;
    }
    if (this._contextPoll) {
      clearInterval(this._contextPoll);
      this._contextPoll = null;
    }
    for (const watcher of this._rolloutWatchers.values()) {
      try { watcher.close(); } catch {}
    }
    this._rolloutWatchers.clear();
    for (const timer of this._rolloutWatchTimers.values()) clearTimeout(timer);
    this._rolloutWatchTimers.clear();
    if (this.rl) {
      try {
        this.rl.close();
      } catch {}
      this.rl = null;
    }
    const prev = this.proc;
    this.proc = null;
    this.connected = false;
    if (prev) {
      prev.removeAllListeners('exit');
      try {
        prev.kill();
      } catch {}
    }
  }

  _attachIO() {
    const proc = this.proc;
    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on('line', (line) => this._onLine(line));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return; // superseded by reconnect
      this.connected = false;
      this.mode = 'offline';
      this.proc = null;
      this.emitState(lt('bridge.disconnected', { code }));
    });
  }

  _onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.emit('log', trimmed);
      return;
    }

    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }

    if (msg.method) this._onNotification(msg);
  }

  _onNotification(msg) {
    const { method, params = {}, id } = msg;

    if (method === 'serverRequest/approval' && id != null) {
      const threadId = params.threadId;
      const idx = this.agents.findIndex((a) => a.threadId === threadId);
      const slot = idx >= 0 ? idx : this.selected;
      this.approvals.set(String(id), { threadId, slot, params });
      this.agents[slot].status = 'input';
      this.agents[slot].approvalId = String(id);
      if (params.command) this.agents[slot].name = truncate(params.command, 42);
      this.emitState(lt('bridge.needsApproval'));
      return;
    }

    if (method === 'turn/started' || method === 'item/started') {
      const idx = this._indexForThread(params.threadId);
      if (idx >= 0) {
        this.agents[idx].status = 'thinking';
        if (params.turnId) this.agents[idx].turnId = params.turnId;
        this.emitState(lt('bridge.thinking'));
      }
      return;
    }

    if (method === 'turn/completed') {
      const idx = this._indexForThread(params.threadId);
      if (idx >= 0) {
        this.agents[idx].status = 'complete';
        this.agents[idx].turnId = null;
        this.emitState(lt('bridge.complete'));
      }
      return;
    }

    if (method === 'thread/settings/updated') {
      const idx = this._indexForThread(params.threadId);
      if (idx >= 0 && params.threadSettings) {
        const settings = params.threadSettings;
        const agent = this.agents[idx];
        if (settings.model) {
          agent.model = settings.model;
          agent.modelSource = 'app-server';
        }
        const effort = settings.reasoningEffort || settings.reasoning_effort;
        if (effort) {
          const i = REASONING.indexOf(effort);
          if (i >= 0) {
            agent.reasoningIndex = i;
            agent.reasoning = effort;
            agent.fastMode = effort === 'minimal';
          }
        }
        const fastMode = typeof settings.fastMode === 'boolean' ? settings.fastMode : settings.fast_mode;
        if (typeof fastMode === 'boolean') agent.fastMode = fastMode;
        if (idx === this.selected && typeof agent.fastMode === 'boolean') this.fastMode = agent.fastMode;
        this.emitState(null);
      }
      return;
    }

    if (method === 'error' || method === 'turn/failed') {
      const idx = this._indexForThread(params.threadId);
      if (idx >= 0) {
        this.agents[idx].status = 'error';
        this.emitState(lt('bridge.error'));
      }
    }
  }

  _indexForThread(threadId) {
    if (!threadId) return this.selected;
    const i = this.agents.findIndex((a) => a.threadId === threadId);
    return i >= 0 ? i : -1;
  }

  request(method, params = {}) {
    if (!this.proc) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', method, id, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify(payload) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 15000);
    });
  }

  notify(method, params = {}) {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  respond(id, result) {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  async _handshake() {
    await this.request('initialize', {
      clientInfo: { name: 'agent-micro', version: '1.2.0' },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          'item/commandExecution/outputDelta',
          'item/agentMessage/delta',
        ],
      },
    });
    this.notify('initialized', {});
  }

  async refreshThreads() {
    if (this._refreshThreadsPending) return this._refreshThreadsPending;
    this._refreshThreadsPending = this._refreshThreadsNow();
    try {
      return await this._refreshThreadsPending;
    } finally {
      this._refreshThreadsPending = null;
    }
  }

  async _refreshThreadsNow() {
    if (!this.connected) return;
    let result;
    try {
      result = await this.request('thread/list', { limit: 24 });
    } catch {
      try {
        result = await this.request('thread/list', {});
      } catch {
        return;
      }
    }

    const threads = normalizeThreads(result);
    const byId = new Map(threads.map((t) => [t.id, t]));
    // thread/list includes historical threads. Reconcile our CLI-backed slots
    // against the actual terminal windows so a closed Agent pane does not stay
    // visibly active forever.
    let openCliSlots = null;
    if (process.platform === 'darwin') {
      try { openCliSlots = await mac.listOpenCodexCliSlots?.(); } catch { openCliSlots = null; }
    }

    // Only sync slots we already own (CLI / fork / select).
    // Never pack global history into empty keys — that made fork look "full" at 6/6
    // even when only 1–5 Codex · Agent panes were open.
    for (let i = 0; i < 6; i++) {
      const prev = this.agents[i];
      if (!prev.threadId || String(prev.threadId).startsWith('demo')) continue;
      if (Array.isArray(openCliSlots) && prev.rolloutPath && !openCliSlots.includes(i)) {
        this.agents[i] = emptyAgent();
        continue;
      }
      const t = byId.get(prev.threadId);
      if (!t) continue;

      const status = prev.approvalId
        ? 'input'
        : mapThreadStatus(t) || prev.status || 'idle';
      this.agents[i] = {
        name: t.title || t.preview || t.cwd || prev.name || `Agent ${i + 1}`,
        status,
        cwd: t.cwd || prev.cwd || this._configuredWorkingDirectory(),
        projectRoot: prev.projectRoot,
        rolloutPath: prev.rolloutPath,
        projectName: this._projectName(t.cwd || prev.cwd || this._configuredWorkingDirectory()),
        threadId: t.id,
        turnId: prev.turnId,
        approvalId: prev.approvalId,
        model: prev.model,
        reasoning: prev.reasoning,
        reasoningIndex: prev.reasoningIndex,
        fastMode: prev.fastMode,
        preFastReasoningIndex: prev.preFastReasoningIndex,
      };
    }
    const liveSlots = this.agents
      .map((agent, slot) => ({ agent, slot }))
      .filter(({ agent }) => agent.status !== 'off');
    await Promise.all(liveSlots.map(async ({ agent, slot }) => {
      const liveCwd = await mac.getCliSlotWorkingDirectory?.(slot);
      if (!liveCwd) return;
      agent.cwd = liveCwd;
      const rollout = await mac.getCliSlotRolloutPath?.(slot);
      this._updateProjectContext(agent, liveCwd, rollout);
    }));
    this._syncRolloutWatchers();
    this.emitState(null);
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
  }

  async select(index, { focus = false } = {}) {
    const requested = Math.max(0, Math.min(5, index));

    // CLI: Agent 1 = new window · 2–6 = split in that window only (in order)
    let slot = requested;
    try {
      // Always bring the Agent CLI pane forward on select (ignore dbl-tap flag).
      const r = await this.ensureAgentCliWindow(requested, { focus: true });
      if (r?.mode === 'blocked') {
        this.emitState(r.error || lt('bridge.order'));
        return { ok: false, reason: r.reason || 'blocked', slot: requested };
      }
      if (typeof r?.slot === 'number') slot = r.slot;
      this.selected = slot;
      const a = this.agents[this.selected];
      if (a.status === 'complete') a.status = 'idle';
      // Mark live when CLI opens — do NOT thread/start here.
      // Phantom app-server ids without rollouts break later thread/fork.
      if (a.status === 'off') {
        a.status = 'idle';
        if (!a.name || a.name === '—') a.name = this._slotName(slot);
        a.cwd = this._configuredWorkingDirectory();
        a.projectName = this._projectName(a.cwd);
      }
      const liveCwd = await mac.getCliSlotWorkingDirectory?.(slot);
      if (liveCwd) {
        a.cwd = liveCwd;
        const rollout = await mac.getCliSlotRolloutPath?.(slot);
        this._updateProjectContext(a, liveCwd, rollout);
      }
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

  syncSelectedSlot(index) {
    const slot = Math.max(0, Math.min(5, Number(index) || 0));
    if (slot === this.selected) return false;
    this.selected = slot;
    const agent = this.agents[slot];
    if (agent && agent.status === 'off') {
      agent.status = 'idle';
      agent.name = this._slotName(slot);
      agent.cwd = this._configuredWorkingDirectory(slot);
      agent.projectName = this._projectName(agent.cwd);
    }
    this.emitState(`Agent ${slot + 1} · focused`);
    return true;
  }

  /** Shell command to launch interactive Codex CLI in Terminal. */
  _codexCliCommand(slot = this.selected) {
    return this._codexSubcommand('', slot);
  }

  _configuredWorkingDirectory(slot = this.selected) {
    try {
      const settings = require('../codex-settings').load();
      return require('../agent-rules').effectiveWorkingDirectory(settings, slot);
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

  _slotName(slot) {
    try {
      const settings = require('../codex-settings').load();
      return require('../agent-rules').resolve(settings, slot).profile.name || `Agent ${slot + 1}`;
    } catch { return `Agent ${slot + 1}`; }
  }

  _updateProjectContext(agent, liveCwd, rolloutPath = null) {
    const projectRoot = (rolloutPath && detectProjectFromRollout(rolloutPath, liveCwd))
      || detectActiveProject(liveCwd)
      || liveCwd;
    agent.rolloutPath = rolloutPath || agent.rolloutPath || null;
    const rolloutModel = readRolloutModel(agent.rolloutPath);
    if (rolloutModel.changed && rolloutModel.model) {
      agent.model = rolloutModel.model;
      agent.modelSource = 'rollout';
    }
    if (rolloutModel.changed && rolloutModel.reasoning) {
      const index = REASONING.indexOf(rolloutModel.reasoning);
      if (index >= 0) {
        agent.reasoning = rolloutModel.reasoning;
        agent.reasoningIndex = index;
        agent.fastMode = rolloutModel.reasoning === 'minimal';
        if (agent === this.agents[this.selected]) this.fastMode = agent.fastMode;
      }
    }
    agent.projectRoot = projectRoot;
    agent.projectName = this._projectName(projectRoot);
    const id = String(rolloutPath || '').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
    if (id && !agent.threadId) agent.threadId = id;
  }

  _syncRolloutWatchers() {
    const wanted = new Map();
    this.agents.forEach((agent, slot) => {
      const file = String(agent?.rolloutPath || '').trim();
      if (agent?.status !== 'off' && file && fs.existsSync(file)) wanted.set(file, slot);
    });
    for (const [file, watcher] of this._rolloutWatchers) {
      if (wanted.has(file)) continue;
      try { watcher.close(); } catch {}
      this._rolloutWatchers.delete(file);
    }
    for (const [file, slot] of wanted) {
      if (this._rolloutWatchers.has(file)) continue;
      try {
        const watcher = fs.watch(file, { persistent: false }, () => {
          const oldTimer = this._rolloutWatchTimers.get(file);
          if (oldTimer) clearTimeout(oldTimer);
          const timer = setTimeout(() => {
            this._rolloutWatchTimers.delete(file);
            const agent = this.agents[slot];
            if (!agent || agent.status === 'off' || agent.rolloutPath !== file) return;
            const before = `${agent.model || ''}|${agent.reasoning || ''}|${agent.fastMode}`;
            this._updateProjectContext(agent, agent.cwd, file);
            const after = `${agent.model || ''}|${agent.reasoning || ''}|${agent.fastMode}`;
            if (before !== after) this.emitState(null);
          }, 40);
          this._rolloutWatchTimers.set(file, timer);
        });
        this._rolloutWatchers.set(file, watcher);
      } catch (error) {
        this.emit('log', `rollout watch: ${error.message}`);
      }
    }
  }

  /** Sync model/reasoning/Fast for already-associated CLI rollouts. */
  async refreshAgentContexts() {
    if (this._refreshContextsPending) return this._refreshContextsPending;
    this._refreshContextsPending = this._refreshAgentContextsNow();
    try {
      return await this._refreshContextsPending;
    } finally {
      this._refreshContextsPending = null;
    }
  }

  async _refreshAgentContextsNow() {
    if (!this.connected) return;
    let changed = false;
    for (const agent of this.agents) {
      if (!agent || agent.status === 'off' || !agent.rolloutPath) continue;
      const before = `${agent.model || ''}|${agent.reasoning || ''}|${agent.fastMode}`;
      this._updateProjectContext(agent, agent.cwd, agent.rolloutPath);
      const after = `${agent.model || ''}|${agent.reasoning || ''}|${agent.fastMode}`;
      if (before !== after) changed = true;
    }
    this._syncRolloutWatchers();
    if (changed) this.emitState(null);
  }

  async _updateSelectedThreadSettings(settings = {}) {
    const agent = this.agents[this.selected];
    const threadId = String(agent?.threadId || '').trim();
    if (!this.connected || !threadId || threadId.startsWith('demo')) {
      return { ok: false, error: 'Selected agent is not linked to a Codex thread', slot: this.selected };
    }
    try {
      const result = await this.request('thread/settings/update', { threadId, ...settings });
      if (settings.model) agent.model = settings.model;
      if (settings.model) agent.modelSource = 'app-server';
      if (settings.effort) {
        const index = REASONING.indexOf(settings.effort);
        if (index >= 0) {
          agent.reasoningIndex = index;
          agent.reasoning = settings.effort;
        }
      }
      this.emitState(null);
      return { ok: true, slot: this.selected, threadId, settings, result };
    } catch (error) {
      return { ok: false, error: error.message, slot: this.selected, threadId };
    }
  }

  /**
   * Build a Codex CLI launch line with Agent Micro profile flags.
   * Subcommands are appended after global flags so ids are not eaten as PROMPT.
   * @param {string} sub e.g. '' | 'fork --last' | 'resume <uuid>'
   */
  _codexSubcommand(sub, slot = this.selected) {
    const bin = findCodexNative();
    let base = 'codex';
    if (!bin) {
      /* PATH fallback */
    } else if (typeof bin === 'object' && bin.type === 'node') {
      const node = process.execPath.replace(/'/g, `'\\''`);
      const script = String(bin.path).replace(/'/g, `'\\''`);
      base = `ELECTRON_RUN_AS_NODE=1 '${node}' '${script}'`;
    } else {
      base = `'${String(bin).replace(/'/g, `'\\''`)}'`;
    }
    let cmd = base;
    let workingDirectory = '';
    try {
      const { withCliFlags, load, tomlString } = require('../codex-settings');
      const settings = load();
      const launch = require('../agent-rules').resolve(settings, slot);
      const pendingRouting = this._pendingRouting.get(slot) || {};
      const merged = {
        ...settings,
        model: pendingRouting.model || launch.model,
        model_reasoning_effort: pendingRouting.reasoning || launch.reasoning,
        sandbox_mode: launch.sandbox,
        approval_policy: launch.approval,
      };
      const extra = launch.instructions
        ? [`developer_instructions=${tomlString(launch.instructions)}`]
        : [];
      cmd = withCliFlags(base, merged, extra);
      this._pendingRouting.delete(slot);
      workingDirectory = launch.cwd;
    } catch {
      /* keep base */
    }
    const extra = String(sub || '').trim();
    const launch = extra ? `${cmd} ${extra}` : cmd;
    return workingDirectory
      ? `cd '${workingDirectory.replace(/'/g, `'\\''`)}' && ${launch}`
      : launch;
  }

  /**
   * Ensure Terminal has a Codex CLI window for this agent slot.
   * @param {number} slot
   * @param {{ focus?: boolean, command?: string }} [opts]
   *        focus defaults to true; pass false for voice prep (keep pad key focus).
   */
  async ensureAgentCliWindow(slot, opts = {}) {
    if (process.platform !== 'darwin') {
      return { ok: false, error: 'macOS only' };
    }
    return mac.ensureCodexCliWindow(slot, {
      focus: opts.focus !== false,
      command: opts.command || this._codexCliCommand(slot),
    });
  }

  async startThread(slot = this.selected) {
    if (!this.connected) return;
    const cwd = this._configuredWorkingDirectory(slot);
    const result = await this.request('thread/start', { cwd });
    const id = result?.thread?.id || result?.threadId || result?.id;
    if (id) {
      this.agents[slot] = {
        name: this._slotName(slot),
        status: 'idle',
        cwd,
        threadId: id,
        turnId: null,
        approvalId: null,
      };
      this.selected = slot;
      this.emitState(lt('bridge.newThread'));
    }
  }

  /** Approve in the visible Agent CLI (key `y`) — not hidden app-server. */
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
        this.approvals.delete(a.approvalId);
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

  /** Decline in the visible Agent CLI (key `n`). */
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
        this.approvals.delete(a.approvalId);
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

  /**
   * Send prompt into the visible Agent CLI terminal (paste + Return).
   * Does not use the hidden app-server turn/start path.
   */
  async send(text, options = {}) {
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

      if (options.clearInput) await mac.clearCliInput(slot);
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

  async setReasoning(index) {
    const reasoningIndex = Math.max(0, Math.min(REASONING.length - 1, index));
    const value = REASONING[reasoningIndex];
    let updated = await this._updateSelectedThreadSettings({ effort: value });
    // CLI windows may not have a live app-server thread id. In that case,
    // update the Codex config used by the visible CLI as a fallback.
    if (!updated.ok && this.connected) {
      try {
        await this.request('config/set', { key: 'model_reasoning_effort', value });
        updated = { ok: true, mode: 'config' };
      } catch {
        /* retain the original thread error for the UI */
      }
    }
    if (!updated.ok) return { ok: false, value, applied: false, ...updated };
    this.reasoningIndex = reasoningIndex;
    if (this.agents[this.selected]) {
      this.agents[this.selected].reasoningIndex = reasoningIndex;
      this.agents[this.selected].reasoning = value;
      this.agents[this.selected].fastMode = value === 'minimal';
    }
    this.fastMode = value === 'minimal';
    this.emitState(lt('bridge.reasoning', { value }));
    return { ok: true, value, applied: true, ...updated };
  }

  async applyRouting({ model = '', reasoning = '' } = {}) {
    const targetModel = String(model || '').trim();
    const targetReasoning = REASONING.includes(reasoning) ? reasoning : '';
    const agent = this.agents[this.selected];
    if (!agent || agent.status === 'off') {
      this._pendingRouting.set(this.selected, {
        model: targetModel,
        reasoning: targetReasoning,
      });
      return {
        ok: true,
        applied: true,
        modelApplied: !!targetModel,
        reasoningApplied: !!targetReasoning,
        mode: 'next-launch',
      };
    }
    const changes = {};
    if (targetModel && targetModel !== agent?.model) changes.model = targetModel;
    if (targetReasoning && targetReasoning !== agent?.reasoning) changes.effort = targetReasoning;
    if (!Object.keys(changes).length) {
      return {
        ok: true,
        applied: true,
        unchanged: true,
        modelApplied: !!targetModel,
        reasoningApplied: !!targetReasoning,
      };
    }

    const updated = await this._updateSelectedThreadSettings(changes);
    if (updated.ok) {
      if (targetReasoning) {
        const index = REASONING.indexOf(targetReasoning);
        this.reasoningIndex = index;
        this.fastMode = targetReasoning === 'minimal';
      }
      this.emitState(`auto route · ${targetModel || agent?.model || 'model'} · ${targetReasoning || agent?.reasoning || 'auto'}`);
      return {
        ok: true,
        applied: true,
        modelApplied: !targetModel || agent?.model === targetModel,
        reasoningApplied: !targetReasoning || agent?.reasoning === targetReasoning,
        mode: 'thread',
        ...updated,
      };
    }

    let reasoningResult = null;
    if (targetReasoning) {
      reasoningResult = await this.setReasoning(REASONING.indexOf(targetReasoning));
    }
    return {
      ok: !!reasoningResult?.ok,
      applied: !!reasoningResult?.ok,
      modelApplied: !targetModel || agent?.model === targetModel,
      reasoningApplied: !targetReasoning || !!reasoningResult?.ok,
      mode: reasoningResult?.mode || 'recommendation',
      error: updated.error,
    };
  }

  async toggleFast() {
    const agent = this.agents[this.selected];
    const nextFastMode = !this.fastMode;
    // Fast is a CLI slash command. Keep the pad and the visible CLI on the
    // same path so pressing “Fast Off” really executes `/fast` there.
    const updated = await this.send('/fast', { clearInput: true });
    if (!updated?.ok) return { ok: false, fastMode: this.fastMode, applied: false, ...updated };
    this.fastMode = nextFastMode;
    if (agent) agent.fastMode = nextFastMode;
    this.emitState(nextFastMode ? lt('bridge.fastOn') : lt('bridge.fastOff'));
    return { ok: true, fastMode: nextFastMode, applied: true };
  }

  async togglePlan() {
    this.planMode = !this.planMode;

    if (this.connected) {
      try {
        await this.request('config/set', { key: 'plan_mode', value: this.planMode });
      } catch {
        try {
          await this.request('config/set', {
            key: 'model_reasoning_effort',
            value: this.planMode ? 'high' : REASONING[this.reasoningIndex],
          });
        } catch {
          /* ignore */
        }
      }
    }
    this.emitState(this.planMode ? lt('bridge.planOn') : lt('bridge.planOff'));
    return this.planMode;
  }

  async openModelPicker() {
    if (this._modelPickerPending) return this._modelPickerPending;
    const slot = this.selected;
    this._modelPickerPending = (async () => {
      try {
        const focus = await this.ensureAgentCliWindow(slot, { focus: true });
        if (!focus?.ok) return { ok: false, error: focus?.error || focus?.reason || 'Codex CLI unavailable', slot };
        await mac.clearCliInput(slot);
        await mac.submitToCli(slot, '/model');
        this.emitState('Codex · model picker');
        return { ok: true, slot, mode: 'cli' };
      } catch (error) {
        this.emit('log', `model picker cli: ${error.message}`);
        return { ok: false, error: error.message, slot };
      }
    })();
    try {
      return await this._modelPickerPending;
    } finally {
      this._modelPickerPending = null;
    }
  }

  async switchModel(rawModel) {
    const model = String(rawModel || '').trim();
    // Accept provider-owned ids (for example deepseek-chat or a local model),
    // while keeping the value bounded and shell/JSON safe.
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model)) return { ok: false, error: 'Invalid model name' };
    const slot = this.selected;
    const updated = await this._updateSelectedThreadSettings({ model });
    if (updated.ok) {
      this.emitState(`Codex · ${model}`);
      return { ok: true, slot, model, mode: 'app-server', applied: true };
    }
    const picker = await this.openModelPicker();
    return picker?.ok
      ? { ...picker, modelPicker: true, slot, error: 'Codex requires the model picker for this unlinked conversation' }
      : { ok: false, error: updated.error || picker?.error || 'Codex model unavailable', slot };
  }

  async skill(name) {
    const text = SKILLS[name] || SKILLS.continue;
    const result = await this.send(text);
    this.emitState(lt('bridge.skill', { name }));
    return result;
  }

  async newChat() {
    const empty = this.agents.findIndex((a) => a.status === 'off');
    const slot = empty === -1 ? this.selected : empty;
    this.selected = slot;
    if (!this.connected) {
      this.agents[slot] = demo('New task', 'idle');
    } else {
      // The visible CLI owns the session. Starting a hidden app-server thread here
      // creates a phantom id with no rollout, so later resume/fork operations fail.
      this.agents[slot] = {
        name: this._slotName(slot), status: 'idle', cwd: this._configuredWorkingDirectory(slot), threadId: null, turnId: null, approvalId: null,
      };
    }
    // Always open/focus the visible CLI for that slot
    try {
      await this.ensureAgentCliWindow(slot, { focus: true });
    } catch (e) {
      this.emit('log', `newChat cli: ${e.message}`);
    }
    this.emitState(lt('bridge.newChatDemo', { n: slot + 1 }));
    return { ok: true, slot, mode: 'cli' };
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
      case 'newChat':
      case 'newDesktopChat': {
        const shortcut = action === 'newDesktopChat' ? 'newChat' : action;
        try {
          const r = await mac.desktopShortcut(shortcut);
          this.emitState(r?.label || shortcut);
          return r;
        } catch (e) {
          this.emit('log', `desktop ${shortcut}: ${e.message}`);
          this.emitState(lt('bridge.unknown', { action: shortcut }));
          return { ok: false, reason: e.message };
        }
      }
      default:
        this.emitState(lt('bridge.unknown', { action }));
        return { ok: false, reason: 'unknown' };
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

  /**
   * Ensure login + a CLI slot for later paste. Does not start dictation and must
   * not steal key focus (pad sink needs to stay first-responder).
   */
  async prepareVoiceDictation() {
    const slot = this.selected;
    try {
      const login = await this.checkLogin();
      if (!login.hasCodex) {
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

  /**
   * Start macOS dictation into the pad's focused text sink.
   * Caller (main) must refocus the pad after prepareVoiceDictation.
   */
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

  /** Stop dictation only — renderer reads sink text and calls submitVoiceText. */
  async endVoiceDictation() {
    const slot = this.selected;
    try {
      await mac.triggerDictation('stop');
      // Let macOS flush composed text into the focused sink
      await new Promise((r) => setTimeout(r, 420));
      return { ok: true, slot, mode: 'pad-sink' };
    } catch (e) {
      this.emit('log', e.message);
      return { ok: false, error: e.message, slot };
    }
  }

  /** Paste dictated text into the selected Agent CLI and submit. */
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
}

function isNoRolloutError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('no rollout found') ||
    msg.includes('thread not found') ||
    msg.includes('not loaded')
  );
}

/** Safe for shell: session ids are UUIDs; reject anything else. */
function shellQuoteId(id) {
  const s = String(id || '').trim();
  if (!/^[0-9a-fA-F-]{8,}$/.test(s)) return '';
  return s;
}

function sessionsRoot() {
  return path.join(os.homedir(), '.codex', 'sessions');
}

/** Return rollout jsonl path for a thread id, or null. */
function findRolloutPathForThread(threadId) {
  const id = String(threadId || '').trim();
  if (!id || id.startsWith('demo')) return null;
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return null;

  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (ent.name.includes(id) && ent.name.endsWith('.jsonl')) return full;
    }
  }
  return null;
}

/** Newest rollout thread id under ~/.codex/sessions, or null. */
function findNewestRolloutThreadId() {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return null;

  let best = null;
  let bestMtime = -1;
  const stack = [root];
  const re = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      const m = ent.name.match(re);
      if (!m) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = m[1];
      }
    }
  }
  return best;
}

function normalizeThreads(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result.map(normalizeThread).filter(Boolean);
  const list = result.threads || result.items || result.data || [];
  return (Array.isArray(list) ? list : []).map(normalizeThread).filter(Boolean);
}

function normalizeThread(t) {
  if (!t) return null;
  const id = t.id || t.threadId || t.thread_id;
  if (!id) return null;
  return {
    id,
    title: t.title || t.name || t.summary || t.preview || null,
    preview: t.preview || t.lastMessage || null,
    cwd: t.cwd || t.workingDirectory || null,
    status: t.status || t.state || null,
  };
}

function mapThreadStatus(t) {
  const s = String(t.status || '').toLowerCase();
  if (!s) return null;
  if (/run|activ|progress|think|stream/.test(s)) return 'thinking';
  if (/wait|approv|input|interrupt/.test(s)) return 'input';
  if (/err|fail/.test(s)) return 'error';
  if (/done|complete/.test(s)) return 'complete';
  if (/idle|ready/.test(s)) return 'idle';
  return null;
}

function focusChatGPT() {
  mac.focusCodexApp().catch(() => {
    execFile('open', ['-b', 'com.openai.codex'], () => {});
  });
}

module.exports = { CodexBridge, REASONING, SKILLS, focusChatGPT, findCodexNative, parsePluginListOutput };
