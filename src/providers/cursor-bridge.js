const path = require('path');
const { BaseBridge, openUrl, truncate, emptyAgent } = require('./base-bridge');

function getApiKey() {
  return process.env.CURSOR_API_KEY || process.env.CURSOR_API_TOKEN || '';
}

class CursorBridge extends BaseBridge {
  constructor() {
    super('cursor');
    this._Agent = null;
    this._handles = Array.from({ length: 6 }, () => null);
    this._cwd = process.cwd();
  }

  getLinkInfo() {
    const key = getApiKey();
    return {
      provider: this.provider,
      hasBinary: !!this._Agent || this._canLoadSdk(),
      connected: this.connected,
      mode: this.mode,
      loggedIn: !!key,
    };
  }

  _canLoadSdk() {
    try {
      require.resolve('@cursor/sdk');
      return true;
    } catch {
      return false;
    }
  }

  _loadSdk() {
    if (this._Agent) return this._Agent;
    // eslint-disable-next-line import/no-extraneous-dependencies
    const mod = require('@cursor/sdk');
    this._Agent = mod.Agent || mod.default?.Agent || mod;
    return this._Agent;
  }

  async checkLogin() {
    const hasSdk = this._canLoadSdk();
    const key = getApiKey();
    this._loggedIn = !!(hasSdk && key);
    return {
      hasBinary: hasSdk,
      loggedIn: this._loggedIn,
      detail: !hasSdk
        ? 'pnpm add @cursor/sdk'
        : key
          ? 'CURSOR_API_KEY set'
          : 'set CURSOR_API_KEY',
    };
  }

  async login() {
    const status = await this.checkLogin();
    if (!status.hasBinary) {
      this.emitState('install @cursor/sdk · pnpm install');
      return { ok: false, reason: 'missing' };
    }
    if (status.loggedIn) return { ok: true, reason: 'already', ...status };
    openUrl('https://cursor.com/settings');
    this.emitState('set CURSOR_API_KEY then Connect');
    return { ok: false, reason: 'not-logged-in', ...status };
  }

  async start() {
    const status = await this.checkLogin();
    if (!status.hasBinary) {
      this._seedDemo();
      this.emitState('cursor sdk missing');
      return false;
    }
    if (!status.loggedIn) {
      this._seedDemo();
      this.emitState('CURSOR_API_KEY needed');
      return false;
    }
    try {
      this._loadSdk();
    } catch (err) {
      this._seedDemo();
      this.emitState(`cursor sdk · ${err.message}`);
      return false;
    }
    this.connected = true;
    this.mode = 'cursor';
    for (let i = 0; i < this.agents.length; i++) {
      this.agents[i] = {
        ...emptyAgent(),
        name: `Cursor ${i + 1}`,
        status: 'idle',
        threadId: `cursor-${i}`,
      };
    }
    this.emitState('connected · cursor');
    return true;
  }

  stop() {
    for (let i = 0; i < this._handles.length; i++) {
      const h = this._handles[i];
      this._handles[i] = null;
      try {
        h?.close?.();
        h?.dispose?.();
      } catch {}
    }
    this.connected = false;
    this.mode = 'offline';
  }

  focusApp() {
    const { execFile } = require('child_process');
    if (process.platform === 'darwin') {
      execFile('open', ['-a', 'Cursor'], () => {});
    }
  }

  async _ensureAgent(slot) {
    if (this._handles[slot]) return this._handles[slot];
    const Agent = this._loadSdk();
    const apiKey = getApiKey();
    const agent = await Agent.create({
      apiKey,
      local: { cwd: this._cwd || path.resolve('.') },
    });
    this._handles[slot] = agent;
    return agent;
  }

  async send(text) {
    if (!this.connected) {
      this.emitState('sent (demo)');
      return;
    }
    const slot = this.selected;
    const a = this.agents[slot];
    a.status = 'thinking';
    a.name = truncate(text, 42);
    this.emitState('thinking');
    try {
      const agent = await this._ensureAgent(slot);
      const run = await agent.send(text);
      if (run?.stream) {
        for await (const _msg of run.stream()) {
          /* drain */
        }
      } else if (run?.wait) {
        await run.wait();
      } else if (typeof run?.then === 'function') {
        await run;
      }
      a.status = 'complete';
      const resultText = run?.result || run?.text || '';
      if (resultText) a.name = truncate(String(resultText), 42);
      this.emitState('complete');
    } catch (err) {
      a.status = 'error';
      this.emit('log', err.message);
      this.emitState(`send failed · ${err.message.slice(0, 40)}`);
    }
  }

  async newChat() {
    const slot = this.selected;
    const prev = this._handles[slot];
    this._handles[slot] = null;
    try {
      prev?.close?.();
      prev?.dispose?.();
    } catch {}
    this.agents[slot] = {
      ...emptyAgent(),
      name: 'New task',
      status: 'idle',
      threadId: `cursor-${slot}-${Date.now()}`,
    };
    this.emitState(`new chat · Agent ${slot + 1}`);
  }

  async desktopAction(action) {
    this.focusApp();
    this.emitState(`desktop · ${action}`);
  }
}

module.exports = { CursorBridge };
