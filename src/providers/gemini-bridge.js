const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { BaseBridge, whichSync, openUrl, truncate, emptyAgent } = require('./base-bridge');

function findGeminiBin() {
  for (const cmd of ['gemini', 'agy']) {
    const p = whichSync(cmd);
    if (p) return { bin: p, cmd };
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'gemini'),
    '/usr/local/bin/gemini',
    '/opt/homebrew/bin/gemini',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { bin: c, cmd: 'gemini' };
  }
  return null;
}

class GeminiBridge extends BaseBridge {
  constructor() {
    super('gemini');
    this._binInfo = null;
    this._proc = null;
    this._rl = null;
    this._nextId = 1;
    this._pending = new Map();
    this._sessionId = null;
  }

  getLinkInfo() {
    const info = findGeminiBin();
    return {
      provider: this.provider,
      hasBinary: !!info,
      connected: this.connected,
      mode: this.mode,
      loggedIn: this._loggedIn ?? null,
    };
  }

  async checkLogin() {
    const info = findGeminiBin();
    this._binInfo = info;
    if (!info) {
      this._loggedIn = false;
      return { hasBinary: false, loggedIn: false, detail: 'gemini CLI not found' };
    }
    if (info.cmd === 'agy') {
      this._loggedIn = false;
      return {
        hasBinary: true,
        loggedIn: false,
        detail: 'Antigravity CLI has no ACP yet — use gemini --acp',
      };
    }
    this._loggedIn = true;
    return { hasBinary: true, loggedIn: true, detail: info.bin };
  }

  async login() {
    const info = findGeminiBin();
    if (!info) {
      openUrl('https://github.com/google-gemini/gemini-cli');
      this.emitState('install gemini CLI · then Connect');
      return { ok: false, reason: 'missing' };
    }
    if (info.cmd === 'agy') {
      this.emitState('need gemini --acp (not agy)');
      return { ok: false, reason: 'no-acp' };
    }
    this.emitState('login · Gemini…');
    try {
      await this._runOnce(info.bin, ['auth', 'login'], 120000);
    } catch {
      try {
        await this._runOnce(info.bin, ['login'], 120000);
      } catch (err) {
        this.emit('log', err.message);
      }
    }
    const status = await this.checkLogin();
    return status.loggedIn
      ? { ok: true, ...status }
      : { ok: false, reason: 'not-logged-in', ...status };
  }

  async start() {
    const status = await this.checkLogin();
    if (!status.hasBinary) {
      this._seedDemo();
      this.emitState('gemini missing · install CLI');
      return false;
    }
    if (this._binInfo?.cmd === 'agy') {
      this._seedDemo();
      this.emitState('agy has no ACP · use gemini');
      return false;
    }
    try {
      await this._spawnAcp();
      this.connected = true;
      this.mode = 'acp';
      for (let i = 0; i < this.agents.length; i++) {
        this.agents[i] = {
          ...emptyAgent(),
          name: `Gemini ${i + 1}`,
          status: 'idle',
          threadId: `gemini-${i}`,
        };
      }
      this.emitState('connected · gemini');
      return true;
    } catch (err) {
      this.emit('log', err.message);
      this._seedDemo();
      this.emitState(`gemini acp failed · ${err.message.slice(0, 32)}`);
      return false;
    }
  }

  stop() {
    if (this._rl) {
      try {
        this._rl.close();
      } catch {}
      this._rl = null;
    }
    if (this._proc) {
      this._proc.removeAllListeners('exit');
      try {
        this._proc.kill();
      } catch {}
      this._proc = null;
    }
    this._pending.clear();
    this._sessionId = null;
    this.connected = false;
    this.mode = 'offline';
  }

  focusApp() {
    const { execFile } = require('child_process');
    if (process.platform === 'darwin') {
      execFile('open', ['-a', 'Gemini'], () => {});
    }
  }

  async _spawnAcp() {
    const info = this._binInfo || findGeminiBin();
    if (!info) throw new Error('no gemini binary');
    const child = spawn(info.bin, ['--acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this._proc = child;
    this._rl = readline.createInterface({ input: child.stdout });
    this._rl.on('line', (line) => this._onLine(line));
    child.stderr.on('data', (d) => this.emit('log', d.toString().trim()));
    child.on('error', (e) => this.emit('log', e.message));
    child.on('exit', () => {
      if (this._proc === child) {
        this.connected = false;
        this.mode = 'offline';
        this.emitState('disconnected');
      }
    });

    await this._request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'agent-micro', version: '1.0.0' },
    });
    try {
      await this._request('authenticate', {});
    } catch {
      /* some builds skip auth */
    }
    const session = await this._request('session/new', {
      cwd: process.cwd(),
    }).catch(() => this._request('newSession', { cwd: process.cwd() }));
    this._sessionId =
      session?.sessionId || session?.session_id || session?.id || 'default';
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
      const p = this._pending.get(msg.id);
      if (p) {
        this._pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'session/update' || msg.method === 'sessionUpdate') {
      const a = this.agents[this.selected];
      const update = msg.params?.update || msg.params || {};
      if (update.sessionUpdate === 'agent_message_chunk' || update.text) {
        a.status = 'thinking';
      }
      if (update.sessionUpdate === 'available_commands_update') {
        /* ignore */
      }
      this.emitState(null);
    }
  }

  _request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this._proc) return reject(new Error('not connected'));
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      this._proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, id, params }) + '\n');
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 20000);
    });
  }

  async send(text) {
    if (!this.connected || !this._proc) {
      this.emitState('sent (demo)');
      return;
    }
    const a = this.agents[this.selected];
    a.status = 'thinking';
    a.name = truncate(text, 42);
    this.emitState('thinking');
    try {
      await this._request('session/prompt', {
        sessionId: this._sessionId,
        prompt: [{ type: 'text', text }],
      }).catch(() =>
        this._request('prompt', {
          sessionId: this._sessionId,
          prompt: text,
        })
      );
      a.status = 'complete';
      this.emitState('complete');
    } catch (err) {
      a.status = 'error';
      this.emit('log', err.message);
      this.emitState(`send failed · ${err.message.slice(0, 40)}`);
    }
  }

  async newChat() {
    if (!this.connected) {
      this.emitState('new chat (demo)');
      return;
    }
    try {
      const session = await this._request('session/new', { cwd: process.cwd() }).catch(() =>
        this._request('newSession', { cwd: process.cwd() })
      );
      this._sessionId =
        session?.sessionId || session?.session_id || session?.id || `gemini-${Date.now()}`;
      const slot = this.selected;
      this.agents[slot] = {
        ...emptyAgent(),
        name: 'New task',
        status: 'idle',
        threadId: this._sessionId,
      };
      this.emitState(`new chat · Agent ${slot + 1}`);
    } catch (err) {
      this.emitState(`new chat failed · ${err.message.slice(0, 32)}`);
    }
  }

  async desktopAction(action) {
    this.focusApp();
    this.emitState(`desktop · ${action}`);
  }

  _runOnce(bin, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => {
        out += d.toString();
      });
      child.stderr.on('data', (d) => {
        err += d.toString();
      });
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        reject(new Error('timeout'));
      }, timeoutMs);
      child.on('close', (code) => {
        clearTimeout(t);
        if (code === 0) resolve(out);
        else reject(new Error(err || out || `exit ${code}`));
      });
      child.on('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }
}

module.exports = { GeminiBridge, findGeminiBin };
