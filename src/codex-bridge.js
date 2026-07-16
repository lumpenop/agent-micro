const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const EventEmitter = require('events');
const mac = require('./platform/mac');

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

function findCodexNative() {
  const root = path.join(__dirname, '..', 'node_modules', '@openai');
  const map = {
    'darwin-arm64': path.join(
      root,
      'codex-darwin-arm64',
      'vendor',
      'aarch64-apple-darwin',
      'bin',
      'codex'
    ),
    'darwin-x64': path.join(
      root,
      'codex-darwin-x64',
      'vendor',
      'x86_64-apple-darwin',
      'bin',
      'codex'
    ),
  };
  const key = `${process.platform}-${process.arch}`;
  const candidate = map[key];
  if (candidate && fs.existsSync(candidate)) return candidate;

  const js = path.join(root, 'codex', 'bin', 'codex.js');
  if (fs.existsSync(js)) return { type: 'node', path: js };
  return null;
}

class CodexBridge extends EventEmitter {
  constructor() {
    super();
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

  emitState(action) {
    this.emit('state', { ...this.getState(), action });
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
    await this.refreshThreads().catch((e) => this.emit('log', e.message));
    this.emitState('connected · ' + this.mode);
    this._poll = setInterval(() => {
      this.refreshThreads().catch(() => {});
    }, 4000);
    return true;
  }

  _spawnServer(bin, args, mode) {
    return new Promise((resolve, reject) => {
      let child;
      if (typeof bin === 'object' && bin.type === 'node') {
        child = spawn(process.execPath, [bin.path, ...args], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
      } else {
        child = spawn(bin, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });
      }

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
    if (this._poll) clearInterval(this._poll);
    if (this.rl) this.rl.close();
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {}
    }
    this.proc = null;
    this.connected = false;
  }

  _attachIO() {
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => this._onLine(line));
    this.proc.on('exit', (code) => {
      this.connected = false;
      this.mode = 'offline';
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
      result = await this.request('thread/list', { limit: 6 });
    } catch {
      try {
        result = await this.request('thread/list', {});
      } catch {
        return;
      }
    }

    const threads = normalizeThreads(result);
    for (let i = 0; i < 6; i++) {
      const t = threads[i];
      if (!t) {
        if (!this.agents[i].approvalId) this.agents[i] = emptyAgent();
        continue;
      }
      const prev = this.agents[i];
      const status = prev.approvalId
        ? 'input'
        : mapThreadStatus(t) || (prev.threadId === t.id ? prev.status : 'idle');
      this.agents[i] = {
        name: t.title || t.preview || t.cwd || `Thread ${i + 1}`,
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

  select(index, { focus = false } = {}) {
    this.selected = Math.max(0, Math.min(5, index));
    const a = this.agents[this.selected];
    if (a.status === 'complete') a.status = 'idle';
    if (a.status === 'off' && this.connected) {
      this.startThread(this.selected).catch(() => {});
    }
    if (focus) focusChatGPT();
    this.emitState(focus ? `focus · Agent ${index + 1}` : `switch · Agent ${index + 1}`);
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

  async fork() {
    const src = this.agents[this.selected];
    if (!this.connected || !src.threadId || String(src.threadId).startsWith('demo')) {
      const empty = this.agents.findIndex((a) => a.status === 'off');
      const target = empty === -1 ? (this.selected + 1) % 6 : empty;
      this.agents[target] = {
        name: `${src.name} · continued`,
        status: 'thinking',
        threadId: src.threadId,
        turnId: null,
        approvalId: null,
      };
      this.selected = target;
      this.emitState(`fork → Agent ${target + 1}`);
      return;
    }
    try {
      const result = await this.request('thread/fork', { threadId: src.threadId });
      const id = result?.thread?.id || result?.threadId || result?.id;
      const empty = this.agents.findIndex((a) => a.status === 'off');
      const target = empty === -1 ? (this.selected + 1) % 6 : empty;
      this.agents[target] = {
        name: `${src.name} · fork`,
        status: 'idle',
        threadId: id,
        turnId: null,
        approvalId: null,
      };
      this.selected = target;
      this.emitState(`fork → Agent ${target + 1}`);
    } catch (e) {
      this.emitState(`fork failed · ${e.message}`);
    }
  }

  async send(text) {
    const a = this.agents[this.selected];
    if (!this.connected || !a.threadId || String(a.threadId).startsWith('demo')) {
      a.status = 'thinking';
      this.emitState('sent (demo)');
      setTimeout(() => {
        a.status = 'complete';
        this.emitState('complete');
      }, 2200);
      return;
    }
    try {
      a.status = 'thinking';
      this.emitState('sent');
      const result = await this.request('turn/start', {
        threadId: a.threadId,
        userInput: text || 'Continue.',
      });
      a.turnId = result?.turn?.id || result?.turnId || null;
    } catch (e) {
      a.status = 'error';
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
  }

  toggleFast() {
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
        await this.request('config/set', {
          key: 'plan_mode',
          value: this.planMode,
        });
      } catch {
        try {
          await this.request('config/set', {
            key: 'model_reasoning_effort',
            value: this.planMode ? 'high' : REASONING[this.reasoningIndex],
          });
        } catch {}
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
      this.emitState(`new chat · Agent ${slot + 1}`);
      return;
    }
    this.agents[slot] = demo('New task', 'idle');
    this.selected = slot;
    this.emitState(`new chat (demo) · Agent ${slot + 1}`);
  }

  async desktopAction(action) {
    try {
      if (action === 'historyBack') {
        await mac.keystroke('[', ['command']);
        this.emitState('history ←');
      } else if (action === 'historyForward') {
        await mac.keystroke(']', ['command']);
        this.emitState('history →');
      } else if (action === 'sidebar') {
        await mac.keystroke('b', ['command']);
        this.emitState('sidebar');
      } else if (action === 'composer') {
        await mac.keystroke('k', ['command']);
        this.emitState('composer');
      } else if (action === 'newDesktopChat') {
        await mac.keystroke('n', ['command']);
        this.emitState('desktop new chat');
      } else {
        this.emitState(`unknown desktop · ${action}`);
      }
    } catch (e) {
      this.emitState(`mac shortcut failed · grant Accessibility?`);
      this.emit('log', e.message);
    }
  }
}

function emptyAgent() {
  return { name: '—', status: 'off', threadId: null, turnId: null, approvalId: null };
}

function demo(name, status, approvalId = null) {
  return {
    name,
    status,
    threadId: `demo-${name}`,
    turnId: null,
    approvalId,
  };
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

function truncate(s, n) {
  const str = String(s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function focusChatGPT() {
  mac.focusCodexApp().catch(() => {
    execFile('open', ['-b', 'com.openai.codex'], () => {});
  });
}

module.exports = { CodexBridge, REASONING, SKILLS, focusChatGPT };
