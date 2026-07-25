const EventEmitter = require('events');
const codexSettings = require('../codex-settings');
const { REASONING, emptyAgent } = require('./base-bridge');

/** Lightweight text-agent bridge for OpenAI-compatible Chat Completions APIs. */
class OpenAICompatibleBridge extends EventEmitter {
  constructor() {
    super();
    this.provider = 'api';
    this.linkMode = 'api';
    this.connected = false;
    this.mode = 'offline';
    this.reasoningIndex = 2;
    this.fastMode = false;
    this.planMode = false;
    this.selected = 0;
    this.agents = Array.from({ length: 6 }, () => emptyAgent());
    this.messages = [];
  }

  getState() {
    return { provider: this.provider, connected: this.connected, mode: this.mode, linkMode: this.linkMode,
      selected: this.selected, reasoning: REASONING[this.reasoningIndex], reasoningIndex: this.reasoningIndex,
      fastMode: this.fastMode, planMode: this.planMode, agents: this.agents.map((a) => ({ ...a })), canFork: false };
  }

  emitState(action) { this.emit('state', { ...this.getState(), action }); }

  _config() {
    const s = codexSettings.load();
    const base = String(s.api_base_url || '').trim().replace(/\/$/, '');
    const model = String(s.api_model || s.model || '').trim();
    const key = process.env[String(s.api_key_env || 'OPENAI_API_KEY').trim()];
    return { base, model, key };
  }

  getLinkInfo() {
    const c = this._config();
    return { provider: this.provider, hasCodex: false, hasBinary: !!c.base, connected: this.connected,
      mode: this.mode, linkMode: this.linkMode, loggedIn: !!c.key || c.base.includes('localhost') };
  }

  async checkLogin() {
    const c = this._config();
    return { hasCodex: false, hasBinary: !!c.base, loggedIn: !!c.key || c.base.includes('localhost') };
  }

  async login() { return { ok: false, reason: 'api-key-env', error: 'Set the configured API key environment variable and reconnect' }; }

  async connect() {
    const c = this._config();
    if (!c.base || !c.model) {
      this.connected = false; this.mode = 'offline'; this.emitState('api configuration required');
      return { ok: false, reason: 'config', error: 'Set API base URL and model in Settings' };
    }
    this.connected = true; this.mode = 'api';
    this.agents[0] = { ...this.agents[0], name: c.model, status: 'idle' };
    this.emitState('connected');
    return { ok: true, reason: 'connected', loggedIn: true };
  }

  stop() { this.connected = false; this.mode = 'offline'; this.emitState('disconnected'); }
  select(index) { if (index >= 0 && index < this.agents.length) { this.selected = index; this.emitState(`switch · Agent ${index + 1}`); } }
  async setReasoning(index) { this.reasoningIndex = Math.max(0, Math.min(REASONING.length - 1, index)); this.emitState(`reasoning · ${REASONING[this.reasoningIndex]}`); }
  async toggleFast() { this.fastMode = !this.fastMode; if (this.fastMode) this.reasoningIndex = 0; this.emitState(this.fastMode ? 'fast mode on' : 'fast mode off'); }
  async togglePlan() { this.planMode = !this.planMode; this.emitState(this.planMode ? 'plan mode on' : 'plan mode off'); }
  async approve() { this.emitState('approve not supported by API provider'); }
  async decline() { this.emitState('decline not supported by API provider'); }
  async fork() { this.emitState('fork not supported by API provider'); return { ok: false, reason: 'unsupported' }; }
  async readRateLimits() { return null; }

  async send(text) {
    if (!this.connected) return { ok: false, error: 'API provider is not connected' };
    const c = this._config();
    const headers = { 'content-type': 'application/json' };
    if (c.key) headers.authorization = `Bearer ${c.key}`;
    this.messages.push({ role: 'user', content: String(text || '') });
    const response = await fetch(`${c.base}/chat/completions`, { method: 'POST', headers,
      body: JSON.stringify({ model: c.model, messages: this.messages, stream: false }) });
    const body = await response.text();
    if (!response.ok) throw new Error(`API ${response.status}: ${body.slice(0, 500)}`);
    let json; try { json = JSON.parse(body); } catch { throw new Error('API returned invalid JSON'); }
    const content = json?.choices?.[0]?.message?.content || '';
    this.messages.push({ role: 'assistant', content });
    this.emit('log', content);
    this.agents[this.selected] = { ...this.agents[this.selected], status: 'idle' };
    this.emitState('response complete');
    return { ok: true, text: content };
  }
}

module.exports = { OpenAICompatibleBridge };
