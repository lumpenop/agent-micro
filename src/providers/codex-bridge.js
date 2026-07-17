const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const EventEmitter = require('events');
const mac = require('../platform/mac');
const { REASONING, SKILLS, emptyAgent, demo, truncate } = require('./base-bridge');

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

function findCodexNative() {
  const key = `${process.platform}-${process.arch}`;
  const spec = PLATFORM_BIN[key];
  const root = path.join(__dirname, '..', '..', 'node_modules', '@openai');

  if (spec) {
    const hoisted = path.join(root, path.basename(spec.pkg), ...spec.parts);
    if (fs.existsSync(hoisted)) return hoisted;
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

  const js = path.join(root, 'codex', 'bin', 'codex.js');
  if (fs.existsSync(js)) return { type: 'node', path: js };
  return null;
}

function spawnCodex(bin, args, opts = {}) {
  if (typeof bin === 'object' && bin.type === 'node') {
    return spawn(process.execPath, [bin.path, ...args], {
      ...opts,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(opts.env || {}) },
    });
  }
  return spawn(bin, args, {
    ...opts,
    env: { ...process.env, ...(opts.env || {}) },
  });
}

class CodexBridge extends EventEmitter {
  constructor() {
    super();
    this.provider = 'codex';
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
   * UI stays enabled until 6/6; runtime still needs a live source agent.
   */
  async fork() {
    const active = this._activeCount();
    if (active < 1) {
      this.emitState('fork · no source agent');
      return { ok: false, reason: 'no-source' };
    }
    if (active >= 6) {
      this.emitState('fork · slots full (6/6)');
      return { ok: false, reason: 'full' };
    }

    const target = this._nextForkSlot();
    if (target < 0) {
      this.emitState('fork · slots full (6/6)');
      return { ok: false, reason: 'full' };
    }

    const src = this.agents[this.selected];
    if (!src || src.status === 'off') {
      this.emitState('fork · select a live agent');
      return { ok: false, reason: 'no-source' };
    }

    let threadId = src.threadId;
    let name = `${src.name || 'Agent'} · fork`;
    let status = 'idle';

    if (!this.connected || !threadId || String(threadId).startsWith('demo')) {
      // Demo / offline: copy slot state into empty agent
      name = `${src.name || 'Agent'} · continued`;
      status = 'thinking';
      threadId = src.threadId || `demo-fork-${Date.now()}`;
    } else {
      try {
        const result = await this.request('thread/fork', { threadId: src.threadId });
        threadId = result?.thread?.id || result?.threadId || result?.id;
        if (!threadId) {
          this.emitState('fork failed · no thread id');
          return { ok: false, reason: 'no-id' };
        }
      } catch (e) {
        this.emitState(`fork failed · ${e.message}`);
        return { ok: false, error: e.message };
      }
    }

    this.agents[target] = {
      name,
      status,
      threadId,
      turnId: null,
      approvalId: null,
    };
    this.selected = target;

    // Always open/focus CLI split for the fork target (Agent N pane)
    try {
      await this.ensureAgentCliWindow(target, { focus: true });
    } catch (e) {
      this.emit('log', `fork cli: ${e.message}`);
    }

    this.emitState(`fork → Agent ${target + 1} · split`);
    return { ok: true, slot: target };
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
    try {
      const out = await this._runCodex(bin, ['login', 'status'], 8000);
      const loggedIn = /logged in/i.test(out);
      this._loggedIn = loggedIn;
      return { hasCodex: true, loggedIn, detail: out.trim() };
    } catch (err) {
      this._loggedIn = false;
      return { hasCodex: true, loggedIn: false, detail: err.message };
    }
  }

  /** Opens ChatGPT device login in the browser, then reports status. */
  async login() {
    const bin = findCodexNative();
    if (!bin) {
      this.emitState('codex missing · run pnpm install');
      return { ok: false, reason: 'missing' };
    }
    this.emitState('login · browser opening…');
    this.emit('log', 'Opening Codex login…');
    try {
      await this._runCodex(bin, ['login'], 180000);
    } catch (err) {
      this.emit('log', `login: ${err.message}`);
    }
    const status = await this.checkLogin();
    if (!status.loggedIn) {
      this.emitState('login needed · click Connect');
      return { ok: false, reason: 'not-logged-in', ...status };
    }
    this.emitState('logged in · connecting…');
    return { ok: true, ...status };
  }

  /** Connect via CLI app-server (stdio or proxy). */
  async connect({ forceLogin = false } = {}) {
    const bin = findCodexNative();
    if (!bin) {
      this._seedDemo();
      this.emitState('codex missing · pnpm install');
      return { ok: false, reason: 'missing', linkMode: 'cli' };
    }

    const status = await this.checkLogin();
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
      needsApiKey: started,
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
      this.emitState('codex not found · demo');
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
        this.emitState('offline · demo mode');
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
    this.emitState('connected · cli');
    this._poll = setInterval(() => {
      this.refreshThreads().catch(() => {});
    }, 4000);
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
      this.emitState(`disconnected (${code})`);
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
      this.emitState('needs approval');
      return;
    }

    if (method === 'turn/started' || method === 'item/started') {
      const idx = this._indexForThread(params.threadId);
      if (idx >= 0) {
        this.agents[idx].status = 'thinking';
        if (params.turnId) this.agents[idx].turnId = params.turnId;
        this.emitState('thinking');
      }
      return;
    }

    if (method === 'turn/completed') {
      const idx = this._indexForThread(params.threadId);
      if (idx >= 0) {
        this.agents[idx].status = 'complete';
        this.agents[idx].turnId = null;
        this.emitState('complete');
      }
      return;
    }

    if (method === 'error' || method === 'turn/failed') {
      const idx = this._indexForThread(params.threadId);
      if (idx >= 0) {
        this.agents[idx].status = 'error';
        this.emitState('error');
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
      clientInfo: { name: 'codex-micro-electron', version: '1.0.0' },
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

    // Only sync slots we already own (CLI / fork / select).
    // Never pack global history into empty keys — that made fork look "full" at 6/6
    // even when only 1–5 Codex · Agent panes were open.
    for (let i = 0; i < 6; i++) {
      const prev = this.agents[i];
      if (prev.status === 'thinking' || prev.status === 'input') continue;
      if (!prev.threadId || String(prev.threadId).startsWith('demo')) continue;

      const t = byId.get(prev.threadId);
      if (!t) continue;

      const status = prev.approvalId
        ? 'input'
        : mapThreadStatus(t) || prev.status || 'idle';
      this.agents[i] = {
        name: t.title || t.preview || t.cwd || prev.name || `Agent ${i + 1}`,
        status,
        threadId: t.id,
        turnId: prev.turnId,
        approvalId: prev.approvalId,
      };
    }
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
      const r = await this.ensureAgentCliWindow(requested, { focus });
      if (r?.mode === 'blocked') {
        this.emitState(r.error || 'Agent 1→6 순서대로');
        return { ok: false, reason: r.reason || 'blocked', slot: requested };
      }
      if (typeof r?.slot === 'number') slot = r.slot;
      this.selected = slot;
      const a = this.agents[this.selected];
      if (a.status === 'complete') a.status = 'idle';
      if (a.status === 'off' && this.connected) {
        this.startThread(this.selected).catch(() => {});
      }
      if (r?.opened && r.mode === 'window') {
        this.emitState(`CLI · Agent ${slot + 1} 창`);
      } else if (r?.opened && (r.mode === 'split' || r.mode === 'tab')) {
        this.emitState(`CLI · Agent ${slot + 1} 스플릿`);
      } else if (r?.focused) {
        this.emitState(`focus · CLI · Agent ${slot + 1}`);
      } else {
        this.emitState(`switch · Agent ${slot + 1}`);
      }
      return { ok: true, slot };
    } catch (e) {
      this.emit('log', e?.message || String(e));
      this.emitState(`CLI 창 실패 · ${e?.message || e}`);
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /** Shell command to launch interactive Codex CLI in Terminal. */
  _codexCliCommand() {
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
    try {
      const { withCliFlags } = require('../codex-settings');
      return withCliFlags(base);
    } catch {
      return base;
    }
  }

  /**
   * Ensure Terminal has a Codex CLI window for this agent slot.
   * @param {number} slot
   * @param {{ focus?: boolean }} [opts]
   */
  async ensureAgentCliWindow(slot, opts = {}) {
    if (process.platform !== 'darwin') {
      return { ok: false, error: 'macOS only' };
    }
    return mac.ensureCodexCliWindow(slot, {
      focus: !!opts.focus,
      command: this._codexCliCommand(),
    });
  }

  async startThread(slot = this.selected) {
    if (!this.connected) return;
    const cwd = process.env.HOME || process.cwd();
    const result = await this.request('thread/start', { cwd });
    const id = result?.thread?.id || result?.threadId || result?.id;
    if (id) {
      this.agents[slot] = {
        name: 'New task',
        status: 'idle',
        threadId: id,
        turnId: null,
        approvalId: null,
      };
      this.selected = slot;
      this.emitState('new thread');
    }
  }

  async approve() {
    const a = this.agents[this.selected];
    if (!a?.approvalId) {
      this.emitState('nothing to approve');
      return;
    }
    if (this.connected && !String(a.approvalId).startsWith('demo')) {
      const rid = a.approvalId;
      this.respond(/^\d+$/.test(rid) ? Number(rid) : rid, { decision: 'accept' });
    }
    this.approvals.delete(a.approvalId);
    a.approvalId = null;
    a.status = 'thinking';
    this.emitState('approved');
  }

  async decline() {
    const a = this.agents[this.selected];
    if (!a?.approvalId) {
      this.emitState('nothing to decline');
      return;
    }
    if (this.connected && !String(a.approvalId).startsWith('demo')) {
      const rid = a.approvalId;
      this.respond(/^\d+$/.test(rid) ? Number(rid) : rid, { decision: 'decline' });
    }
    this.approvals.delete(a.approvalId);
    a.approvalId = null;
    a.status = 'idle';
    this.emitState('declined');
  }

  async send(text) {
    const prompt = text || 'Continue.';
    const a = this.agents[this.selected];
    if (!this.connected) {
      a.status = 'thinking';
      this.emitState('sent (demo)');
      setTimeout(() => {
        a.status = 'complete';
        this.emitState('complete');
      }, 2200);
      return;
    }

    if (!a.threadId || String(a.threadId).startsWith('demo') || a.status === 'off') {
      try {
        await this.startThread(this.selected);
      } catch (e) {
        a.status = 'error';
        this.emitState(`new thread failed · ${e.message}`);
        return;
      }
    }

    const startTurn = (threadId) =>
      this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
      });

    try {
      const markThinking = () => {
        const cur = this.agents[this.selected];
        cur.status = 'thinking';
        cur.name = truncate(prompt, 42);
      };
      markThinking();
      this.emitState('sent · cli');
      let result;
      try {
        result = await startTurn(this.agents[this.selected].threadId);
      } catch (e) {
        if (/thread not found|unknown thread/i.test(e.message)) {
          await this.startThread(this.selected);
          markThinking();
          this.emitState('retry turn');
          result = await startTurn(this.agents[this.selected].threadId);
        } else {
          throw e;
        }
      }
      this.agents[this.selected].turnId = result?.turn?.id || result?.turnId || null;
    } catch (e) {
      this.agents[this.selected].status = 'error';
      this.emit('log', `send: ${e.message}`);
      this.emitState(`send failed · ${e.message}`);
    }
  }

  setReasoning(index) {
    this.reasoningIndex = Math.max(0, Math.min(REASONING.length - 1, index));
    const value = REASONING[this.reasoningIndex];
    if (this.connected) {
      this.request('config/set', { key: 'model_reasoning_effort', value }).catch(() => {});
    }
    this.emitState(`reasoning · ${value}`);
    return value;
  }

  async toggleFast() {
    this.fastMode = !this.fastMode;
    if (this.fastMode) this.setReasoning(0);
    else if (this.reasoningIndex === 0) this.setReasoning(2);
    this.emitState(this.fastMode ? 'fast mode on' : 'fast mode off');
    return this.fastMode;
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
    this.emitState(this.planMode ? 'plan mode on' : 'plan mode off');
    return this.planMode;
  }

  async skill(name) {
    const text = SKILLS[name] || SKILLS.continue;
    await this.send(text);
    this.emitState(`skill · ${name}`);
  }

  async newChat() {
    const empty = this.agents.findIndex((a) => a.status === 'off');
    const slot = empty === -1 ? this.selected : empty;
    if (this.connected) {
      await this.startThread(slot);
      return;
    }
    this.agents[slot] = demo('New task', 'idle');
    this.selected = slot;
    this.emitState(`new chat (demo) · Agent ${slot + 1}`);
  }

  async desktopAction(action) {
    switch (action) {
      case 'historyBack':
        this.select((this.selected - 1 + 6) % 6);
        break;
      case 'historyForward':
        this.select((this.selected + 1) % 6);
        break;
      case 'sidebar':
        this.emitState('sidebar');
        break;
      case 'composer':
        focusChatGPT();
        this.emitState('composer');
        break;
      case 'newChat':
      case 'newDesktopChat':
        await this.newChat();
        break;
      default:
        this.emitState(`unknown · ${action}`);
    }
  }

  async voiceToCodex(text) {
    const body = String(text || '').trim();
    if (!body) {
      this.emitState('empty voice');
      return { ok: false, reason: 'empty' };
    }

    try {
      await this.send(body);
      this.emitState('voice → cli');
      return { ok: true, mode: 'cli' };
    } catch (e) {
      this.emit('log', `voice cli: ${e.message}`);
      this.emitState('voice failed');
      return { ok: false, error: e.message };
    }
  }

  /** No Whisper key: talk inside already-logged-in Codex app (system dictation). */
  async beginVoiceDictation() {
    try {
      const r = await mac.beginCodexDictation();
      this.emitState('Codex에서 말하세요');
      return { ok: true, mode: 'codex-dictation', app: r?.app };
    } catch (e) {
      this.emit('log', e.message);
      const hint =
        e.code === 'NO_CODEX_APP' || e.code === 'WRONG_APP'
          ? e.message
          : 'dictation failed · Codex 앱 + Accessibility?';
      this.emitState(hint);
      return { ok: false, error: hint, code: e.code || 'DICTATION' };
    }
  }

  async endVoiceDictation() {
    try {
      await mac.submitCodexComposer();
      this.emitState('Codex 전송');
      return { ok: true };
    } catch (e) {
      this.emit('log', e.message);
      this.emitState('submit failed');
      return { ok: false, error: e.message };
    }
  }
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

module.exports = { CodexBridge, REASONING, SKILLS, focusChatGPT, findCodexNative };
