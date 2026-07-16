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

function loadKeyIcons() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    stored = {};
  }
  const merged = { ...DEFAULT_KEY_ICONS, ...stored };
  // drop references to icons that no longer exist in the catalog
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

function startRecording({ latched = false } = {}) {
  state.recording = true;
  state.processing = false;
  micLatched = latched;
  padEl.classList.add('recording');
  padEl.classList.remove('processing');
  pad3d?.setRecording(true);
  flashAction(latched ? 'listening (hands-free)' : 'listening…');
}

function stopRecording({ process = true } = {}) {
  if (!state.recording) return;
  state.recording = false;
  micLatched = false;
  padEl.classList.remove('recording');
  pad3d?.setRecording(false);
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
    flashAction('sending voice prompt…');
    await api?.send('Voice prompt from Codex Micro');
  }, 900);
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
  hud.link.textContent = state.connected
    ? `codex · ${state.mode}`
    : state.mode === 'offline'
      ? 'demo mode'
      : state.mode;
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

async function onCmd(cmd) {
  if (cmd === 'mic') {
    const now = Date.now();
    if (now - state.lastMicTap < 350) {
      state.lastMicTap = 0;
      if (state.recording) stopRecording({ process: true });
      else startRecording({ latched: true });
      return;
    }
    state.lastMicTap = now;
    if (!state.recording) startRecording({ latched: false });
    else if (!micLatched) stopRecording({ process: true });
    return;
  }
  if (cmd === 'fast') await api?.toggleFast();
  else if (cmd === 'approve') await api?.approve();
  else if (cmd === 'decline') await api?.decline();
  else if (cmd === 'fork') await api?.fork();
  else if (cmd === 'send') await api?.send('Continue.');
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
    api?.setReasoning(next);
    hud.reason.textContent = REASONING[next];
    flashAction(`reasoning · ${REASONING[next]}`);
  }
}

function onJoy(dir) {
  const now = Date.now();
  if (state.lastJoy.dir === dir && now - state.lastJoy.at < 500) return;
  state.lastJoy = { dir, at: now };
  if (dir === 'up') api?.togglePlan();
  else if (dir === 'right') flashAction('history → forward');
  else if (dir === 'down') flashAction('sidebar toggle');
  else if (dir === 'left') flashAction('history ← back');
}

let pad3d;
try {
  pad3d = createPad3D(canvasHost, {
    onAgent,
    onCmd,
    onIconPick: openIconPicker,
    onDialDelta,
    onDialStart: () => flashAction('reasoning control'),
    onJoy,
    onTouch: () => {
      state.layer = (state.layer + 1) % 3;
      pad3d?.setLayer?.(state.layer);
      flashAction(`layer ${state.layer + 1}`);
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
api?.getState?.().then(applyBridgeState);
