const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { BaseBridge, whichSync, openUrl, truncate, emptyAgent } = require('./base-bridge');

function findClaudeBin() {
  const fromPath = whichSync('claude');
  if (fromPath) return fromPath;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

class ClaudeBridge extends BaseBridge {
  constructor() {
    super('claude');
    this._bin = null;
    this._sessions = Array.from({ length: 6 }, () => ({ sessionId: null }));
    this._running = null;
  }

  getLinkInfo() {
    const bin = findClaudeBin();
    return {
      provider: this.provider,
      hasBinary: !!bin,
      connected: this.connected,
      mode: this.mode,
      loggedIn: this._loggedIn ?? null,
    };
  }

  async checkLogin() {
    const bin = findClaudeBin();
    this._bin = bin;
    if (!bin) {
      this._loggedIn = false;
      return { hasBinary: false, loggedIn: false, detail: 'claude CLI not found' };
    }
    try {
      const out = await this._run(bin, ['--version'], 5000);
      // Presence of binary + successful version is enough; auth checked on first send
      const loggedIn = !/not logged|login required|unauthor/i.test(out);
      this._loggedIn = loggedIn;
      return { hasBinary: true, loggedIn, detail: out.trim().slice(0, 120) };
    } catch (err) {
      this._loggedIn = false;
      return { hasBinary: true, loggedIn: false, detail: err.message };
    }
  }

  async login() {
    const bin = findClaudeBin();
    if (!bin) {
      openUrl('https://claude.ai/download');
      this.emitState('install Claude Code · then Connect');
      return { ok: false, reason: 'missing' };
    }
    this.emitState('login · Claude…');
    try {
      await this._run(bin, ['auth', 'login'], 180000);
    } catch {
      try {
        await this._run(bin, ['login'], 180000);
      } catch (err) {
        this.emit('log', `claude login: ${err.message}`);
        openUrl('https://claude.ai/login');
      }
    }
    const status = await this.checkLogin();
    if (!status.loggedIn) {
      this.emitState('login needed · Claude');
      return { ok: false, reason: 'not-logged-in', ...status };
    }
    this.emitState('logged in · connecting…');
    return { ok: true, ...status };
  }

  async start() {
    const status = await this.checkLogin();
    if (!status.hasBinary) {
      this._seedDemo();
      this.emitState('claude missing · install CLI');
      return false;
    }
    this._bin = findClaudeBin();
    this.connected = true;
    this.mode = 'claude';
    for (let i = 0; i < this.agents.length; i++) {
      if (this.agents[i].status === 'off') {
        this.agents[i] = {
          ...emptyAgent(),
          name: `Claude ${i + 1}`,
          status: 'idle',
          threadId: `claude-${i}`,
        };
      }
    }
    this.emitState('connected · claude');
    return true;
  }

  stop() {
    if (this._running) {
      try {
        this._running.kill();
      } catch {}
      this._running = null;
    }
    this.connected = false;
    this.mode = 'offline';
  }

  focusApp() {
    const { execFile } = require('child_process');
    if (process.platform === 'darwin') {
      execFile('open', ['-a', 'Claude'], () => {});
    }
  }

  async send(text) {
    if (!this.connected || !this._bin) {
      this.emitState('sent (demo)');
      return;
    }
    const slot = this.selected;
    const a = this.agents[slot];
    a.status = 'thinking';
    a.name = truncate(text, 42);
    this.emitState('thinking');

    const args = [
      '-p',
      text,
      '--output-format',
      'text',
      '--permission-mode',
      'dontAsk',
    ];
    const session = this._sessions[slot];
    if (session.sessionId) {
      args.push('--resume', session.sessionId);
    }

    try {
      const out = await this._run(this._bin, args, 300000, (child) => {
        this._running = child;
      });
      this._running = null;
      a.status = 'complete';
      if (out) a.name = truncate(out.split('\n').filter(Boolean).pop() || text, 42);
      this.emitState('complete');
    } catch (err) {
      this._running = null;
      a.status = 'error';
      this.emit('log', err.message);
      this.emitState(`send failed · ${err.message.slice(0, 40)}`);
    }
  }

  async newChat() {
    const slot = this.selected;
    this._sessions[slot] = { sessionId: null };
    this.agents[slot] = {
      ...emptyAgent(),
      name: 'New task',
      status: 'idle',
      threadId: `claude-${slot}-${Date.now()}`,
    };
    this.emitState(`new chat · Agent ${slot + 1}`);
  }

  async desktopAction(action) {
    this.focusApp();
    this.emitState(`desktop · ${action}`);
  }

  _run(bin, args, timeoutMs = 15000, onSpawn) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        cwd: process.cwd(),
      });
      onSpawn?.(child);
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
        reject(new Error(`timeout: claude ${args[0] || ''}`));
      }, timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out.trim());
        else reject(new Error(err.trim() || out.trim() || `exit ${code}`));
      });
    });
  }
}

module.exports = { ClaudeBridge, findClaudeBin };
