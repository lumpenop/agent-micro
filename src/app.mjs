import { createPad3D } from './pad3d.mjs';
import {
  KEYCAP_ICONS,
  DEFAULT_KEY_ICONS,
  ICON_ORDER,
  iconMarkup,
} from './icons.mjs';

const REASONING = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const api = window.codexDesktop;
const STORAGE_KEY = 'codex-micro-key-icons-v4-codex';

/** All layers → Codex CLI (app-server) */
const LAYERS = [
  {
    name: 'Codex',
    joy: {
      up: () => api?.togglePlan(),
      down: () => api?.newChat(),
      left: () => api?.desktop('historyBack'),
      right: () => api?.desktop('historyForward'),
    },
  },
  {
    name: 'Prompts',
    joy: {
      up: () => api?.skill('review'),
      down: () => api?.skill('docs'),
      left: () => api?.skill('refactor'),
      right: () => api?.skill('debug'),
    },
  },
  {
    name: 'App',
    joy: {
      up: () => api?.send('Continue.'),
      down: () => api?.skill('explain'),
      left: () => api?.fork(),
      right: () => api?.newChat(),
    },
  },
];

function layerDisplayName(layerIndex) {
  return LAYERS[layerIndex]?.name || `L${layerIndex + 1}`;
}

/** Icon → Codex actions (all brands map to Codex for now) */
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
  chatgpt: () => api?.send('Continue.'),
  claude: () => api?.send('Continue.'),
  anthropic: () => api?.send('Continue.'),
  cursor: () => api?.send('Continue.'),
  gemini: () => api?.send('Continue.'),
  grok: () => api?.send('Continue.'),
  deepseek: () => api?.send('Continue.'),
  mistral: () => api?.send('Continue.'),
  perplexity: () => api?.send('Continue.'),
  qwen: () => api?.send('Continue.'),
  kimi: () => api?.send('Continue.'),
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
  linkMode: 'cli',
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
let micGranted = null;
let micWarmPromise = null;
let micStream = null;
let mediaRecorder = null;
let micChunks = [];
let micMime = 'audio/webm';
let micFinishing = false;
/** 'whisper' | 'codex-dictation' */
let voiceMode = 'codex-dictation';
let dictationActive = false;

const voicePanel = document.getElementById('voice-panel');
const voiceTitleEl = document.getElementById('voice-title');
const voiceLeadEl = document.getElementById('voice-lead');
const voiceModeEl = document.getElementById('voice-mode');
const voiceHintEl = document.getElementById('voice-hint');
const voiceApiKeyEl = document.getElementById('voice-api-key');
let voicePromptedThisSession = false;

async function refreshVoiceStatus() {
  const s = await api?.voiceStatus?.();
  if (!s) return null;
  voiceMode = s.mode || (s.whisperReady ? 'whisper' : 'codex-dictation');
  if (voiceModeEl) {
    voiceModeEl.textContent = s.whisperReady
      ? '마이크 준비됨 · Whisper'
      : 'Codex 연결 후 · API 키 저장 필요';
  }
  if (voiceHintEl) {
    voiceHintEl.textContent = s.whisperReady
      ? '키캡 마이크 · 말하기 → Codex'
      : '키 발급 → 붙여넣기 → 저장하고 완료';
  }
  return s;
}

function openVoicePanel({ fromConnect = false } = {}) {
  if (voiceTitleEl) {
    voiceTitleEl.textContent = fromConnect ? 'CLI · API 키' : 'API 키 · 마이크';
  }
  if (voiceLeadEl) {
    voiceLeadEl.textContent = fromConnect
      ? 'Codex CLI 연결이 끝났습니다. Whisper용 Platform API 키(sk-…)를 저장하세요.'
      : '마이크(Whisper) → CLI 전송에 쓰는 OpenAI API 키입니다.';
  }
  if (voiceModeEl) {
    voiceModeEl.textContent = fromConnect ? 'CLI 연결 완료 · API 키 저장' : 'Codex CLI · Whisper';
  }
  voicePanel?.removeAttribute('hidden');
  refreshVoiceStatus();
  flashAction(fromConnect ? 'API 키 설정' : '마이크 / API 키');
  voiceApiKeyEl?.focus?.();
}

function closeVoicePanel() {
  voicePanel?.setAttribute('hidden', '');
}

async function maybePromptVoiceSetup(result, { force = false } = {}) {
  const needs =
    force ||
    result?.needsApiKey ||
    result?.needsVoiceSetup ||
    (await api?.voiceStatus?.())?.needsSetup;
  if (!needs) return false;
  if (voicePromptedThisSession && !force) return false;
  voicePromptedThisSession = true;
  openVoicePanel({ fromConnect: true });
  return true;
}

async function startCodexDictation({ latched = false } = {}) {
  if (dictationActive) return;
  flashAction('Codex로 이동…');
  const r = await api?.beginVoiceDictation?.();
  if (!r?.ok) {
    // ⌘K가 Cursor 팔레트를 연 경우 등 — Whisper 키 설정으로 유도
    flashAction(r?.error || 'Codex 앱을 연 뒤 다시');
    openVoicePanel({ fromConnect: false });
    return;
  }
  dictationActive = true;
  state.recording = true;
  micLatched = latched;
  padEl.classList.add('recording');
  pad3d?.setRecording(true);
  flashAction(latched ? 'Codex에서 말하세요 (탭으로 전송)' : 'Codex에서 말하세요 · 떼면 전송');
}

async function stopCodexDictation({ submit = true } = {}) {
  if (!dictationActive && !state.recording) return;
  dictationActive = false;
  state.recording = false;
  micLatched = false;
  padEl.classList.remove('recording');
  pad3d?.setRecording(false);
  if (!submit) {
    flashAction('받아쓰기 취소');
    await api?.endVoiceDictation?.();
    return;
  }
  flashAction('Codex 전송…');
  await api?.endVoiceDictation?.();
  flashAction('Codex 전송');
}

function stopMicStream() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop();
    } catch {
      /* ignore */
    }
  }
  mediaRecorder = null;
  if (!micStream) return;
  try {
    micStream.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  micStream = null;
}

function pickRecorderMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const t of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
  }
  return '';
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

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

async function startRecording({ latched = false } = {}) {
  await refreshVoiceStatus();
  // CLI: Whisper + API key. Desktop: app dictation unless key saved.
  if (state.linkMode === 'cli' && voiceMode !== 'whisper') {
    flashAction('CLI · API 키 필요');
    openVoicePanel({ fromConnect: true });
    return;
  }
  if (voiceMode !== 'whisper') {
    await startCodexDictation({ latched });
    return;
  }

  const ok = await ensureMicPermission({ silent: true });
  if (!ok) {
    flashAction('mic blocked · allow in System Settings');
    return;
  }

  micFinishing = false;
  stopMicStream();
  micChunks = [];

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    flashAction('mic stream failed');
    return;
  }

  micMime = pickRecorderMime();
  try {
    mediaRecorder = micMime
      ? new MediaRecorder(micStream, { mimeType: micMime })
      : new MediaRecorder(micStream);
    micMime = mediaRecorder.mimeType || micMime || 'audio/webm';
  } catch {
    flashAction('MediaRecorder 불가');
    stopMicStream();
    return;
  }

  mediaRecorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) micChunks.push(ev.data);
  };

  state.recording = true;
  state.processing = false;
  micLatched = latched;
  padEl.classList.add('recording');
  padEl.classList.remove('processing');
  pad3d?.setRecording(true);
  flashAction(latched ? 'Codex 녹음 (hands-free)' : 'Codex에 말하는 중…');

  try {
    mediaRecorder.start(250);
  } catch {
    flashAction('녹음 시작 실패');
    stopMicStream();
    state.recording = false;
    padEl.classList.remove('recording');
    pad3d?.setRecording(false);
  }
}

async function finishVoiceToCodexFromAudio() {
  if (micFinishing) return;
  micFinishing = true;

  padEl.classList.remove('processing');
  state.processing = false;

  if (!micChunks.length) {
    flashAction('녹음 없음 · 더 길게 홀드');
    micFinishing = false;
    stopMicStream();
    return;
  }

  const blob = new Blob(micChunks, { type: micMime || 'audio/webm' });
  micChunks = [];
  stopMicStream();

  if (blob.size < 800) {
    flashAction('너무 짧음 · 1–2초 말하기');
    micFinishing = false;
    return;
  }

  flashAction('Whisper 인식 중…');
  try {
    const base64 = await blobToBase64(blob);
    const result = await api?.transcribe?.({ base64, mimeType: blob.type || micMime });
    if (!result?.ok) {
      if (result?.code === 'NO_API_KEY') {
        flashAction('API 키 없음 · Codex 받아쓰기로 전환');
        voiceMode = 'codex-dictation';
        openVoicePanel();
      } else {
        flashAction(result?.error || '인식 실패');
      }
      micFinishing = false;
      return;
    }
    const text = String(result.text || '').trim();
    flashAction(`🎤 ${text.slice(0, 48)}`);
    flashAction(`→ Codex · ${text.slice(0, 36)}`);
    await api?.voiceToCodex?.(text);
  } catch (e) {
    flashAction(e?.message || 'voice failed');
  }
  micFinishing = false;
}

function stopRecording({ process = true } = {}) {
  if (dictationActive) {
    stopCodexDictation({ submit: process });
    return;
  }

  if (!state.recording && !mediaRecorder) return;
  state.recording = false;
  micLatched = false;
  padEl.classList.remove('recording');
  pad3d?.setRecording(false);

  if (!process) {
    stopMicStream();
    micChunks = [];
    flashAction('mic off');
    return;
  }

  state.processing = true;
  padEl.classList.add('processing');
  flashAction('녹음 저장 중…');

  const rec = mediaRecorder;
  if (!rec || rec.state === 'inactive') {
    finishVoiceToCodexFromAudio();
    return;
  }

  rec.onstop = () => {
    finishVoiceToCodexFromAudio();
  };
  try {
    rec.stop();
  } catch {
    finishVoiceToCodexFromAudio();
  }
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
    title: 'Codex 음성',
    text: '홀드 = Codex에 말하기 · 떼면 앱+스레드 전송 · 더블탭 = hands-free',
  },
  {
    icons: ['codex'],
    title: 'Send',
    text: 'Codex Continue · 더블탭 = 새 채팅',
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
    text: '탭 = Codex → Prompts → App 레이어 순환',
  },
  { section: '레이어 · Joy (Codex)' },
  {
    key: 'Codex',
    title: '기본',
    text: '↑ Plan · → 히스토리 → · ↓ 사이드바 · ← 히스토리 ←',
  },
  {
    key: 'Prompts',
    title: '프롬프트',
    text: '↑ PR 리뷰 · → 디버그 · ↓ 문서 · ← 리팩터',
  },
  {
    key: 'App',
    title: 'Codex 앱',
    text: '↑ Composer · → 새 채팅 · ↓ 사이드바 · ← 히스토리 ←',
  },
  { section: '팁' },
  {
    key: 'Mic',
    title: 'Codex 음성',
    text: '홀드=녹음 · Whisper 인식 · Codex 전송 (OPENAI_API_KEY)',
  },
  {
    key: '우클릭',
    title: '아이콘 변경',
    text: '커맨드 키 우클릭 또는 ◆ 버튼으로 아이콘 변경',
  },
  {
    key: '↻ / 점',
    title: 'Codex 연결',
    text: '클릭 = Codex 연결 · Shift+점 = 강제 로그인',
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
  }
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
  const link = state.linkMode === 'cli' ? 'CLI' : 'Desktop';
  hud.link.textContent = state.connected
    ? `Codex · ${link} · ${layerName}`
    : state.mode === 'offline'
      ? `demo · ${link} · ${layerName}`
      : `Codex · ${link} · ${layerName}`;
  linkDot.classList.toggle('on', state.connected);
  linkDot.classList.toggle('demo', !state.connected);
  pad3d.setCmdActive('fast', state.fastMode);
}

function applyBridgeState(s) {
  if (!s) return;
  state.connected = !!s.connected;
  state.mode = s.mode || 'offline';
  if (s.linkMode) state.linkMode = s.linkMode;
  state.provider = 'codex';
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

/** Mic PTT: hold = talk · double-tap = hands-free latch */
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
      flashAction('Codex · new chat');
      return;
    }
    await api?.send('Continue.');
    flashAction('Codex · Continue');
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
  // Stick snaps back on window blur when Codex/etc steals focus — don't reset mid-drag
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
  const modeInfo = await api?.getMode?.();
  if (modeInfo?.needsPick) {
    openModePicker();
    return;
  }
  linkDot?.classList.add('busy');
  flashAction(forceLogin ? 'Codex 로그인…' : 'Codex connecting…');
  try {
    const result = forceLogin
      ? await api?.connect?.({ forceLogin: true })
      : await api?.reconnect?.();
    if (result?.linkMode) state.linkMode = result.linkMode;
    if (result?.ok === false && result?.reason === 'missing') {
      flashAction('Codex 없음 · pnpm install');
    } else if (result?.ok === false && result?.reason === 'login') {
      flashAction('Codex 로그인 필요 · ↻ 다시');
    } else if (result?.ok || result === true) {
      const prompted = await maybePromptVoiceSetup(result);
      flashAction(
        prompted
          ? 'CLI · API 키 설정'
          : `Codex · ${state.linkMode === 'cli' ? 'CLI' : 'Desktop'}`
      );
    } else {
      flashAction('demo · 모드/↻ 로 연결');
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
    openModePicker();
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

document.getElementById('btn-mode')?.addEventListener('click', () => openModePicker());

api?.onState?.(applyBridgeState);
api?.onLog?.((m) => {
  if (m) console.log('[agent]', m);
});
api?.onMicStatus?.((s) => {
  if (s?.granted) micGranted = true;
});
api?.onNeedModePick?.(() => openModePicker());
state.provider = 'codex';
api?.getMode?.().then((info) => {
  if (info?.resolved) state.linkMode = info.resolved;
  if (info?.needsPick) openModePicker();
  render();
});
api?.getState?.().then(applyBridgeState);

document.getElementById('btn-voice')?.addEventListener('click', () => openVoicePanel());
document.getElementById('voice-close')?.addEventListener('click', async () => {
  const s = await api?.voiceStatus?.();
  if (s?.needsSetup) await api?.skipVoiceSetup?.();
  closeVoicePanel();
});
document.getElementById('voice-save')?.addEventListener('click', async () => {
  const key = voiceApiKeyEl?.value || '';
  const r = await api?.setVoiceApiKey?.(key);
  if (!r?.ok) {
    flashAction(r?.error || '저장 실패');
    return;
  }
  if (voiceApiKeyEl) voiceApiKeyEl.value = '';
  await refreshVoiceStatus();
  flashAction(r.whisperReady ? 'API 키 · Whisper 준비' : '저장됨');
  closeVoicePanel();
});
document.getElementById('voice-skip')?.addEventListener('click', async () => {
  await api?.skipVoiceSetup?.();
  await refreshVoiceStatus();
  closeVoicePanel();
  flashAction(state.linkMode === 'cli' ? '나중에 · 키 없이 CLI' : '나중에');
});
document.getElementById('voice-open-keys')?.addEventListener('click', () => {
  api?.openApiKeysPage?.();
  flashAction('platform.openai.com 열림');
});

flashAction('Codex · Desktop / CLI');
