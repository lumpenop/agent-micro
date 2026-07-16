import { createPad3D } from './pad3d.mjs';
import {
  KEYCAP_ICONS,
  DEFAULT_KEY_ICONS,
  ICON_ORDER,
  iconMarkup,
} from './icons.mjs';

const REASONING = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const api = window.codexDesktop;
const STORAGE_KEY = 'codex-micro-key-icons-v3';

/** Layer maps — matches Codex Micro style: core / skills / desktop */
const LAYERS = [
  {
    name: 'Codex',
    joy: {
      up: () => api?.togglePlan(),
      down: () => api?.desktop('sidebar'),
      left: () => api?.desktop('historyBack'),
      right: () => api?.desktop('historyForward'),
    },
  },
  {
    name: 'Skills',
    joy: {
      up: () => api?.skill('review'),
      down: () => api?.skill('docs'),
      left: () => api?.skill('refactor'),
      right: () => api?.skill('debug'),
    },
  },
  {
    name: 'Desktop',
    joy: {
      up: () => api?.desktop('composer'),
      down: () => api?.desktop('sidebar'),
      left: () => api?.desktop('historyBack'),
      right: () => api?.desktop('newDesktopChat'),
    },
  },
];

/** Icon → action when that icon is assigned to a command key */
const ICON_ACTIONS = {
  lightning: () => api?.toggleFast(),
  check: () => api?.approve(),
  times: () => api?.decline(),
  fork: () => api?.fork(),
  split: () => api?.fork(),
  send: () => api?.send('Continue.'),
  rocket: () => api?.skill('ship'),
  spark: () => api?.skill('continue'),
  brain: () => api?.togglePlan(),
  terminal: () => api?.desktop('composer'),
  bot: () => api?.skill('review'),
  cpu: () => api?.toggleFast(),
  command: () => api?.desktop('composer'),
  cloud: () => api?.reconnect(),
  wand: () => api?.skill('refactor'),
  hexagon: () => api?.skill('debug'),
  audio: () => startRecording({ latched: true }),
  mic: () => startRecording({ latched: true }),
  codex: () => api?.send('Continue.'),
  chatgpt: () => api?.send('Continue with ChatGPT / Codex context.'),
  claude: () => api?.send('Approach this like Claude: careful, structured, cite tradeoffs.'),
  anthropic: () => api?.send('Approach this like Claude: careful, structured, cite tradeoffs.'),
  cursor: () => api?.send('Optimize for Cursor-style agentic coding edits.'),
  grok: () => api?.send('Be direct and witty like Grok, but stay technical.'),
  gemini: () => api?.send('Use a Gemini-style multimodal / broad-context approach.'),
  deepseek: () => api?.send('Prioritize deep reasoning and code correctness.'),
  mistral: () => api?.send('Be concise and engineering-focused.'),
  perplexity: () => api?.send('Research carefully and cite assumptions.'),
  qwen: () => api?.send('Provide a thorough step-by-step coding plan.'),
  kimi: () => api?.send('Handle long-context carefully; summarize then act.'),
};

function loadKeyIcons() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    stored = {};
  }
  const merged = { ...DEFAULT_KEY_ICONS, ...stored };
  for (const [cmd, id] of Object.entries(merged)) {
    if (!KEYCAP_ICONS[id]) merged[cmd] = DEFAULT_KEY_ICONS[cmd];
  }
  return merged;
}

function saveKeyIcons(map) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

const state = {
  selected: 0,
  fastMode: false,
  planMode: false,
  reasoningIndex: 2,
  recording: false,
  processing: false,
  layer: 0,
  connected: false,
  mode: 'offline',
  lastAgentTap: { index: -1, at: 0 },
  lastMicTap: 0,
  lastSendTap: 0,
  lastJoy: { dir: null, at: 0 },
  agents: Array.from({ length: 6 }, () => ({ name: '—', status: 'off' })),
  keyIcons: loadKeyIcons(),
  pickingCmd: null,
};

const padEl = document.getElementById('pad');
const canvasHost = document.getElementById('pad-canvas');
const linkDot = document.getElementById('link-dot');
const hud = {
  link: document.getElementById('hud-link'),
  task: document.getElementById('hud-task'),
  status: document.getElementById('hud-status'),
  reason: document.getElementById('hud-reason'),
  action: document.getElementById('hud-action'),
};

const picker = document.getElementById('icon-picker');
const pickerGrid = document.getElementById('icon-picker-grid');
const pickerTitle = document.getElementById('icon-picker-title');

function flashAction(text) {
  if (text) hud.action.textContent = text;
}

function statusLabel(s) {
  return (
    {
      idle: 'idle',
      thinking: 'thinking',
      complete: 'complete',
      input: 'needs input',
      error: 'error',
      off: 'no task',
    }[s] || s
  );
}

let micLatched = false;
let recognition = null;
let micTranscript = '';

function getSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = 'ko-KR';
  r.interimResults = true;
  r.continuous = true;
  return r;
}

function startRecording({ latched = false } = {}) {
  state.recording = true;
  state.processing = false;
  micLatched = latched;
  micTranscript = '';
  padEl.classList.add('recording');
  padEl.classList.remove('processing');
  pad3d?.setRecording(true);
  flashAction(latched ? 'listening (hands-free)' : 'listening…');

  recognition?.abort?.();
  recognition = getSpeechRecognition();
  if (!recognition) {
    flashAction('speech API unavailable · will send fallback');
    return;
  }
  recognition.onresult = (ev) => {
    let text = '';
    for (let i = 0; i < ev.results.length; i++) {
      text += ev.results[i][0].transcript;
    }
    micTranscript = text.trim();
    if (micTranscript) flashAction(`🎤 ${micTranscript.slice(0, 48)}`);
  };
  recognition.onerror = (ev) => {
    flashAction(`mic · ${ev.error || 'error'}`);
  };
  try {
    recognition.start();
  } catch {
    flashAction('mic busy');
  }
}

function stopRecording({ process = true } = {}) {
  if (!state.recording) return;
  state.recording = false;
  micLatched = false;
  padEl.classList.remove('recording');
  pad3d?.setRecording(false);
  try {
    recognition?.stop?.();
  } catch {}
  recognition = null;

  if (!process) {
    flashAction('mic off');
    return;
  }
  state.processing = true;
  padEl.classList.add('processing');
  flashAction('processing speech…');
  setTimeout(async () => {
    if (!state.processing) return;
    padEl.classList.remove('processing');
    state.processing = false;
    const text =
      micTranscript ||
      'Voice prompt from Agent Micro (no transcript — check mic permission).';
    flashAction(`sending · ${text.slice(0, 40)}`);
    await api?.send(text);
  }, 500);
}

function applyKeyIcons() {
  if (!pad3d) return;
  Object.entries(state.keyIcons).forEach(([cmd, id]) => {
    pad3d.setKeyIcon(cmd, id);
  });
}

function openIconPicker(cmd) {
  state.pickingCmd = cmd || 'send';
  pickerTitle.textContent = `Icon · ${state.pickingCmd}`;
  const current = state.keyIcons[state.pickingCmd];
  pickerGrid.innerHTML = ICON_ORDER.map((id) => {
    const def = KEYCAP_ICONS[id];
    if (!def) return '';
    return `<button type="button" class="icon-pick${id === current ? ' active' : ''}" data-icon="${id}" title="${def.label}">
      ${iconMarkup(id)}
      <span>${def.label}</span>
    </button>`;
  }).join('');
  picker.hidden = false;
}

function closeIconPicker() {
  state.pickingCmd = null;
  picker.hidden = true;
}

pickerGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.icon-pick');
  if (!btn || !state.pickingCmd) return;
  const id = btn.dataset.icon;
  state.keyIcons[state.pickingCmd] = id;
  saveKeyIcons(state.keyIcons);
  pad3d?.setKeyIcon(state.pickingCmd, id);
  flashAction(`icon · ${KEYCAP_ICONS[id]?.label || id}`);
  closeIconPicker();
});

document.getElementById('icon-picker-close')?.addEventListener('click', closeIconPicker);
picker?.addEventListener('click', (e) => {
  if (e.target === picker) closeIconPicker();
});
document.getElementById('btn-icons')?.addEventListener('click', () => openIconPicker(state.pickingCmd || 'send'));

function render() {
  if (!pad3d) return;
  state.agents.forEach((a, i) => {
    pad3d.setAgent(i, { status: a.status, selected: i === state.selected });
  });
  const current = state.agents[state.selected] || {};
  hud.task.textContent = current.name || '—';
  hud.status.textContent = statusLabel(current.status || 'off');
  hud.reason.textContent = REASONING[state.reasoningIndex];
  const layerName = LAYERS[state.layer]?.name || `L${state.layer + 1}`;
  hud.link.textContent = state.connected
    ? `codex · ${state.mode} · ${layerName}`
    : state.mode === 'offline'
      ? `demo · ${layerName}`
      : `${state.mode} · ${layerName}`;
  linkDot.classList.toggle('on', state.connected);
  linkDot.classList.toggle('demo', !state.connected);
  pad3d.setCmdActive('fast', state.fastMode);
}

function applyBridgeState(s) {
  if (!s) return;
  state.connected = !!s.connected;
  state.mode = s.mode || 'offline';
  state.selected = s.selected ?? state.selected;
  state.reasoningIndex = s.reasoningIndex ?? state.reasoningIndex;
  state.fastMode = !!s.fastMode;
  state.planMode = !!s.planMode;
  if (Array.isArray(s.agents)) state.agents = s.agents;
  if (s.action) flashAction(s.action);
  render();
}

async function onAgent(index) {
  const now = Date.now();
  const dbl = state.lastAgentTap.index === index && now - state.lastAgentTap.at < 350;
  state.lastAgentTap = { index, at: now };
  await api?.select(index, dbl);
}

async function runIconAction(cmd) {
  const iconId = state.keyIcons[cmd];
  const fn = ICON_ACTIONS[iconId];
  if (fn) {
    const r = fn();
    if (r && typeof r.then === 'function') await r;
    return true;
  }
  return false;
}

/** Mic PTT: hold = talk · double-tap down = hands-free latch */
function onMicPress() {
  const now = Date.now();
  if (now - state.lastMicTap < 350) {
    state.lastMicTap = 0;
    if (state.recording && micLatched) {
      stopRecording({ process: true });
    } else {
      startRecording({ latched: true });
    }
    return;
  }
  state.lastMicTap = now;
  if (!state.recording) startRecording({ latched: false });
}

function onMicRelease() {
  if (state.recording && !micLatched) stopRecording({ process: true });
}

async function onCmd(cmd) {
  if (cmd === 'mic') {
    // fallback if press/release not wired
    onMicPress();
    return;
  }

  if (cmd === 'send') {
    const now = Date.now();
    const dbl = now - state.lastSendTap < 350;
    state.lastSendTap = now;
    if (dbl) {
      await api?.newChat();
      return;
    }
    // prefer icon-specific action when not the default send/codex
    const iconId = state.keyIcons.send;
    if (iconId && iconId !== 'send' && ICON_ACTIONS[iconId]) {
      await runIconAction('send');
      return;
    }
    await api?.send('Continue.');
    return;
  }

  // default command + icon override for non-mic keys
  if (cmd === 'fast' || cmd === 'approve' || cmd === 'decline' || cmd === 'fork') {
    const iconId = state.keyIcons[cmd];
    const defaults = { fast: 'lightning', approve: 'check', decline: 'times', fork: 'fork' };
    if (iconId && iconId !== defaults[cmd] && ICON_ACTIONS[iconId]) {
      await runIconAction(cmd);
      return;
    }
  }

  if (cmd === 'fast') await api?.toggleFast();
  else if (cmd === 'approve') await api?.approve();
  else if (cmd === 'decline') await api?.decline();
  else if (cmd === 'fork') await api?.fork();
}

let dialAcc = 0;
function onDialDelta(d) {
  dialAcc += d;
  if (Math.abs(dialAcc) < 28) return;
  const step = dialAcc > 0 ? 1 : -1;
  dialAcc = 0;
  const next = Math.max(0, Math.min(REASONING.length - 1, state.reasoningIndex + step));
  if (next !== state.reasoningIndex) {
    state.reasoningIndex = next;
    if (state.fastMode && next !== 0) {
      state.fastMode = false;
    }
    api?.setReasoning(next);
    hud.reason.textContent = REASONING[next];
    flashAction(`reasoning · ${REASONING[next]}`);
  }
}

function onJoy(dir) {
  const now = Date.now();
  if (state.lastJoy.dir === dir && now - state.lastJoy.at < 450) return;
  state.lastJoy = { dir, at: now };
  const layer = LAYERS[state.layer] || LAYERS[0];
  const fn = layer.joy?.[dir];
  if (fn) fn();
  else flashAction(`joy · ${dir}`);
}

let pad3d;
try {
  pad3d = createPad3D(canvasHost, {
    onAgent,
    onCmd,
    onCmdPress: (cmd) => {
      if (cmd === 'mic') onMicPress();
    },
    onCmdRelease: (cmd) => {
      if (cmd === 'mic') onMicRelease();
    },
    onIconPick: openIconPicker,
    onDialDelta,
    onDialStart: () => flashAction('reasoning control'),
    onJoy,
    onTouch: () => {
      state.layer = (state.layer + 1) % LAYERS.length;
      pad3d?.setLayer?.(state.layer);
      const name = LAYERS[state.layer].name;
      flashAction(`layer · ${name}`);
      render();
    },
  });
  applyKeyIcons();
  render();
  flashAction('3D keycaps ready');
} catch (err) {
  console.error(err);
  canvasHost.innerHTML = `<div style="padding:16px;font:12px/1.4 system-ui;color:#b00020;white-space:pre-wrap">3D pad failed:\n${err?.stack || err}</div>`;
  flashAction('3D error');
}

document.getElementById('btn-min')?.addEventListener('click', () => api?.minimize());
document.getElementById('btn-close')?.addEventListener('click', () => api?.close());
document.getElementById('btn-reconnect')?.addEventListener('click', async () => {
  flashAction('reconnecting…');
  await api?.reconnect();
});

api?.onState?.(applyBridgeState);
api?.onLog?.((m) => {
  if (m) console.log('[codex]', m);
});
api?.getState?.().then(applyBridgeState);
