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

const PROVIDER_LABELS = {
  codex: 'Codex',
  claude: 'Claude',
  cursor: 'Cursor',
  gemini: 'Gemini',
};

/** Layer maps — core / skills / desktop (core name follows active provider) */
const LAYERS = [
  {
    name: 'Core',
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

function layerDisplayName(layerIndex) {
  const layer = LAYERS[layerIndex];
  if (!layer) return `L${layerIndex + 1}`;
  if (layerIndex === 0) return PROVIDER_LABELS[state.provider] || 'Core';
  return layer.name;
}

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
  provider: 'codex',
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
let micGranted = null;
let micWarmPromise = null;

function getSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = 'ko-KR';
  r.interimResults = true;
  r.continuous = true;
  return r;
}

/** Native macOS dialog via main + getUserMedia warm-up for Chromium */
async function ensureMicPermission({ silent = false } = {}) {
  if (micGranted === true) return true;
  if (!micWarmPromise) {
    micWarmPromise = (async () => {
      const native = await api?.requestMic?.();
      if (native === false) {
        micGranted = false;
        return false;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        micGranted = true;
        return true;
      } catch {
        micGranted = native === true;
        return micGranted;
      }
    })().finally(() => {
      micWarmPromise = null;
    });
  }
  const ok = await micWarmPromise;
  if (!silent) {
    flashAction(ok ? 'mic ready' : 'mic permission needed · System Settings');
  }
  return ok;
}

async function startRecording({ latched = false } = {}) {
  const ok = await ensureMicPermission({ silent: true });
  if (!ok) {
    flashAction('mic blocked · allow in System Settings');
    return;
  }

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
document.getElementById('btn-icons')?.addEventListener('click', () => {
  closeGuide();
  openIconPicker(state.pickingCmd || 'send');
});

const GUIDE_ITEMS = [
  { section: '키캡' },
  {
    visual: 'agents',
    title: '에이전트 슬롯',
    text: '투명 키 ×6 · 탭 = 전환 · 더블탭 = 에이전트 앱 포커스',
  },
  {
    icons: ['lightning'],
    title: 'Fast mode',
    text: 'reasoning을 minimal로 · 아이콘 바꾸면 다른 액션',
  },
  {
    icons: ['check', 'times'],
    title: 'Approve / Decline',
    text: '승인 요청 수락 또는 거절',
  },
  {
    icons: ['fork'],
    title: 'Fork',
    text: '현재 스레드를 분기해 새 작업으로',
  },
  {
    icons: ['mic'],
    title: '마이크',
    text: '홀드 = 말하기 · 떼면 전송 · 더블탭 = hands-free',
  },
  {
    icons: ['codex'],
    title: 'Send',
    text: 'Continue 전송 · 더블탭 = 새 채팅 · 아이콘별 프롬프트',
  },
  { section: '컨트롤' },
  {
    key: 'Dial',
    title: '볼륨 / Reasoning',
    text: '돌리면 reasoning 강도 (minimal → xhigh)',
  },
  {
    key: 'Joy',
    title: '조이스틱',
    text: '레이어마다 다름 — 아래 Touch 참고',
  },
  {
    key: 'Touch',
    title: '터치 패드',
    text: '탭 = Core → Skills → Desktop 레이어 순환',
  },
  { section: '레이어 · Joy' },
  {
    key: 'Core',
    title: '기본',
    text: '↑ Plan · → 히스토리 → · ↓ 사이드바 · ← 히스토리 ←',
  },
  {
    key: 'Skills',
    title: '스킬',
    text: '↑ PR 리뷰 · → 디버그 · ↓ 문서 · ← 리팩터',
  },
  {
    key: 'Desktop',
    title: '데스크톱',
    text: '↑ Composer · → 새 채팅 · ↓ 사이드바 · ← 히스토리 ←',
  },
  { section: '팁' },
  {
    key: '우클릭',
    title: '아이콘 변경',
    text: '커맨드 키 우클릭 또는 ◆ 버튼으로 아이콘·동작 변경',
  },
  {
    key: '↻ / 점',
    title: '연결',
    text: '클릭 = 연결 · 미로그인 시 로그인 · Shift+점 = 강제 로그인',
  },
  {
    key: '↻ 길게',
    title: '에이전트 선택',
    text: '새로고침 길게 누르기 · Codex / Claude / Cursor / Gemini',
  },
];

const guidePanel = document.getElementById('guide-panel');
const guideBody = document.getElementById('guide-body');

function guideAgentsVisual() {
  // matches pad layout: row0 empty|A0|A1|empty · row1 A2–A5
  const cells = [
    null, 0, 1, null,
    2, 3, 4, 5,
  ];
  return `<div class="guide-item-key guide-item-key--agents" aria-hidden="true">
    <div class="guide-agent-grid">
      ${cells
        .map((i) =>
          i == null
            ? '<span class="guide-agent-slot empty"></span>'
            : `<span class="guide-agent-cap"><i class="guide-agent-led"></i></span>`
        )
        .join('')}
    </div>
  </div>`;
}

function guideKeyHtml(item) {
  if (item.visual === 'agents') return guideAgentsVisual();
  if (item.icons?.length) {
    const icons = item.icons
      .map((id) => `<span class="guide-ico">${iconMarkup(id)}</span>`)
      .join('<span class="guide-ico-sep" aria-hidden="true"></span>');
    return `<div class="guide-item-key guide-item-key--icons">${icons}</div>`;
  }
  return `<div class="guide-item-key">${String(item.key || '').replace(/\n/g, '<br>')}</div>`;
}

function openGuide() {
  closeIconPicker();
  if (!guideBody || !guidePanel) return;
  let html = '';
  let open = false;
  for (const item of GUIDE_ITEMS) {
    if (item.section) {
      if (open) html += '</div>';
      html += `<div class="guide-group"><div class="guide-section">${item.section}</div>`;
      open = true;
      continue;
    }
    html += `<div class="guide-item">
      ${guideKeyHtml(item)}
      <div class="guide-item-text"><strong>${item.title}</strong>${item.text}</div>
    </div>`;
  }
  if (open) html += '</div>';
  guideBody.innerHTML = html;
  guidePanel.hidden = false;
}

function closeGuide() {
  if (guidePanel) guidePanel.hidden = true;
}

document.getElementById('btn-help')?.addEventListener('click', openGuide);
document.getElementById('guide-close')?.addEventListener('click', closeGuide);
guidePanel?.addEventListener('click', (e) => {
  if (e.target === guidePanel) closeGuide();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeGuide();
    closeIconPicker();
    closeProviderPicker();
  }
});

const providerPanel = document.getElementById('provider-panel');
const providerGrid = document.getElementById('provider-grid');
const providerHint = document.getElementById('provider-hint');
let providerList = [];
let providerPicking = false;

async function openProviderPicker() {
  closeGuide();
  closeIconPicker();
  if (!providerPanel || !providerGrid) return;
  providerList = (await api?.listProviders?.()) || [];
  const info = await api?.getProvider?.();
  const active = info?.resolved || state.provider;
  providerGrid.innerHTML = providerList
    .map(
      (p) => `<button type="button" class="provider-tile${p.id === active ? ' active' : ''}" data-provider="${p.id}">
        <strong>${p.label}</strong>
        <span>${p.blurb}</span>
      </button>`
    )
    .join('');
  if (providerHint) {
    providerHint.textContent = '선택 후 자동으로 로그인·연결을 시도합니다';
  }
  providerPanel.hidden = false;
}

function closeProviderPicker() {
  if (providerPanel) providerPanel.hidden = true;
  providerPicking = false;
}

providerGrid?.addEventListener('click', async (e) => {
  const tile = e.target.closest('[data-provider]');
  if (!tile || providerPicking) return;
  const id = tile.getAttribute('data-provider');
  providerPicking = true;
  providerGrid.querySelectorAll('.provider-tile').forEach((el) => {
    el.classList.toggle('busy', true);
    el.classList.toggle('active', el === tile);
  });
  if (providerHint) providerHint.textContent = `${PROVIDER_LABELS[id] || id} 연결 중…`;
  flashAction(`provider · ${id}`);
  try {
    const result = await api?.setProvider?.(id);
    state.provider = id;
    if (result?.ok) flashAction(`connected · ${id}`);
    else if (result?.reason === 'missing') flashAction(`${id} 설치 필요`);
    else if (result?.reason === 'login') flashAction(`${id} 로그인 필요`);
    else flashAction(result?.reason || `demo · ${id}`);
    closeProviderPicker();
    render();
  } catch (err) {
    flashAction(err?.message || 'provider failed');
    providerPicking = false;
    providerGrid.querySelectorAll('.provider-tile').forEach((el) => el.classList.remove('busy'));
  }
});

document.getElementById('provider-close')?.addEventListener('click', closeProviderPicker);
providerPanel?.addEventListener('click', (e) => {
  if (e.target === providerPanel) closeProviderPicker();
});

function render() {
  if (!pad3d) return;
  state.agents.forEach((a, i) => {
    pad3d.setAgent(i, { status: a.status, selected: i === state.selected });
  });
  const current = state.agents[state.selected] || {};
  hud.task.textContent = current.name || '—';
  hud.status.textContent = statusLabel(current.status || 'off');
  hud.reason.textContent = REASONING[state.reasoningIndex];
  const layerName = layerDisplayName(state.layer);
  const prov = PROVIDER_LABELS[state.provider] || state.provider;
  hud.link.textContent = state.connected
    ? `${prov} · ${state.mode} · ${layerName}`
    : state.mode === 'offline'
      ? `demo · ${prov} · ${layerName}`
      : `${prov} · ${state.mode} · ${layerName}`;
  linkDot.classList.toggle('on', state.connected);
  linkDot.classList.toggle('demo', !state.connected);
  pad3d.setCmdActive('fast', state.fastMode);
}

function applyBridgeState(s) {
  if (!s) return;
  state.connected = !!s.connected;
  state.mode = s.mode || 'offline';
  if (s.provider) state.provider = s.provider;
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
  if (dbl) pad3d?.resetJoy?.();
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
  if (fn) {
    fn();
    // Desktop / focus-stealing actions — return stick ASAP
    if (state.layer === 0 || state.layer === 2) {
      pad3d?.resetJoy?.();
    }
  } else flashAction(`joy · ${dir}`);
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
      flashAction(`layer · ${layerDisplayName(state.layer)}`);
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

async function connectAgent({ forceLogin = false } = {}) {
  linkDot?.classList.add('busy');
  const label = PROVIDER_LABELS[state.provider] || state.provider;
  flashAction(forceLogin ? `${label} 로그인…` : 'connecting…');
  try {
    const result = forceLogin
      ? await api?.connect?.({ forceLogin: true })
      : await api?.reconnect?.();
    if (result?.ok === false && result?.reason === 'missing') {
      flashAction(`${label} 없음 · 설치 확인`);
    } else if (result?.ok === false && result?.reason === 'login') {
      flashAction('로그인 필요 · ↻ 다시 클릭');
    } else if (result?.ok || result === true) {
      flashAction('connected');
    } else {
      flashAction('demo · ↻ 로 연결');
    }
  } catch (err) {
    flashAction(err?.message || 'connect failed');
  } finally {
    linkDot?.classList.remove('busy');
  }
}

document.getElementById('btn-min')?.addEventListener('click', () => api?.minimize());
document.getElementById('btn-close')?.addEventListener('click', () => api?.close());
linkDot?.addEventListener('click', (e) => {
  e.stopPropagation();
  connectAgent({ forceLogin: e.shiftKey });
});

let reconnectHoldTimer = null;
let reconnectHoldFired = false;
const btnReconnect = document.getElementById('btn-reconnect');
btnReconnect?.addEventListener('pointerdown', () => {
  reconnectHoldFired = false;
  reconnectHoldTimer = setTimeout(() => {
    reconnectHoldTimer = null;
    reconnectHoldFired = true;
    openProviderPicker();
  }, 550);
});
btnReconnect?.addEventListener('pointerup', () => {
  if (reconnectHoldTimer) clearTimeout(reconnectHoldTimer);
  reconnectHoldTimer = null;
});
btnReconnect?.addEventListener('pointerleave', () => {
  if (reconnectHoldTimer) clearTimeout(reconnectHoldTimer);
  reconnectHoldTimer = null;
});
btnReconnect?.addEventListener('click', () => {
  if (reconnectHoldFired) {
    reconnectHoldFired = false;
    return;
  }
  connectAgent();
});

api?.onState?.(applyBridgeState);
api?.onLog?.((m) => {
  if (m) console.log('[agent]', m);
});
api?.onMicStatus?.((s) => {
  if (s?.granted) micGranted = true;
});
api?.onNeedProviderPick?.(() => {
  openProviderPicker();
});
api?.getProvider?.().then((info) => {
  if (info?.resolved) state.provider = info.resolved;
  if (info?.needsPick) openProviderPicker();
  render();
});
api?.getState?.().then(applyBridgeState);

ensureMicPermission({ silent: true }).then((ok) => {
  if (ok) flashAction('mic ready');
});
