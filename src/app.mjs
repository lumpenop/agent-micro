import { createPad3D } from './pad3d.mjs';
import {
  KEYCAP_ICONS,
  DEFAULT_KEY_ICONS,
  ICON_ORDER,
  isPickerIcon,
  iconMarkup,
} from './icons.mjs';

const { t: tRaw, normalizeLocale } = window.agentI18n || {
  t: (_loc, key) => key,
  normalizeLocale: (l) => (l === 'ko' ? 'ko' : 'en'),
};

const REASONING = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const api = window.codexDesktop;
const STORAGE_KEY = 'agent-micro-key-icons-v1';

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
    if (!Object.keys(stored).length) {
      const legacy = localStorage.getItem('codex-micro-key-icons-v4-codex');
      if (legacy) {
        stored = JSON.parse(legacy);
        localStorage.setItem(STORAGE_KEY, legacy);
      }
    }
  } catch {
    stored = {};
  }
  const merged = { ...DEFAULT_KEY_ICONS, ...stored };
  for (const [cmd, id] of Object.entries(merged)) {
    // Drop other AI brand marks until multi-agent picker ships
    if (!KEYCAP_ICONS[id] || !isPickerIcon(id)) merged[cmd] = DEFAULT_KEY_ICONS[cmd];
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
  /** @type {'shift' | 'command'} */
  hotkeyModifier: 'shift',
  canFork: true,
  trialExpired: false,
  /** @type {'en' | 'ko'} */
  locale: 'en',
};

function t(key, vars) {
  return tRaw(state.locale || 'en', key, vars);
}

function applyStaticI18n() {
  document.documentElement.lang = state.locale === 'ko' ? 'ko' : 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  }
  for (const el of document.querySelectorAll('[data-i18n-html]')) {
    const key = el.getAttribute('data-i18n-html');
    if (key) el.innerHTML = t(key);
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.setAttribute('title', t(key));
  }
  for (const el of document.querySelectorAll('[data-i18n-aria]')) {
    const key = el.getAttribute('data-i18n-aria');
    if (key) el.setAttribute('aria-label', t(key));
  }
  const setLocaleEl = document.getElementById('set-locale');
  if (setLocaleEl) setLocaleEl.value = state.locale;
  syncModPickerUI();
  const gPanel = document.getElementById('guide-panel');
  const gBody = document.getElementById('guide-body');
  if (gBody && gPanel && !gPanel.hidden) {
    gBody.innerHTML = renderGuideList(getGuideItems());
  }
  const kPanel = document.getElementById('keymap-panel');
  const kBody = document.getElementById('keymap-body');
  if (kBody && kPanel && !kPanel.hidden) {
    kBody.innerHTML = renderGuideList(buildKeymapItems());
  }
  if (state.trialExpired) {
    const sponsor = document.getElementById('trial-sponsor');
    const hint = document.getElementById('trial-lock-hint');
    const hasUrl = !!sponsor && !sponsor.disabled;
    if (hint) hint.textContent = hasUrl ? t('trial.hint.url') : t('trial.hint.noUrl');
  }
}

function applyLocale(locale) {
  state.locale = normalizeLocale(locale);
  applyStaticI18n();
}

function modGlyph(mod = state.hotkeyModifier) {
  return mod === 'command' ? '⌘' : '⇧';
}

const padEl = document.getElementById('pad');
const canvasHost = document.getElementById('pad-canvas');
const linkDot = document.getElementById('link-dot');
const shellEl = document.getElementById('shell');
const trialLockEl = document.getElementById('trial-lock');
const trialSponsorBtn = document.getElementById('trial-sponsor');
const trialCloseBtn = document.getElementById('trial-close');
const trialHintEl = document.getElementById('trial-lock-hint');
const trialKeyInput = document.getElementById('trial-license-key');
const trialActivateBtn = document.getElementById('trial-activate');
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

function applyTrialLock(status) {
  const locked = !!(status?.locked ?? status?.expired);
  state.trialExpired = locked;
  shellEl?.classList.toggle('trial-expired', locked);
  if (!locked) {
    trialLockEl?.setAttribute('hidden', '');
    return;
  }
  closeGuide();
  closeKeymap();
  closeSettings();
  closeVoicePanel();
  closeIconPicker();
  trialLockEl?.removeAttribute('hidden');
  const hasUrl = !!status?.sponsorUrl;
  if (trialSponsorBtn) {
    trialSponsorBtn.disabled = !hasUrl;
  }
  if (trialHintEl) {
    trialHintEl.textContent = hasUrl ? t('trial.hint.url') : t('trial.hint.noUrl');
  }
  flashAction(t('trial.flash'));
}

function trialBlocks() {
  return !!state.trialExpired;
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
    voiceModeEl.textContent = s.whisperReady ? t('voice.mode.ready') : t('voice.mode.needKey');
  }
  if (voiceHintEl) {
    voiceHintEl.textContent = s.whisperReady ? t('voice.hint.ready') : t('voice.hint.needKey');
  }
  return s;
}

function openVoicePanel({ fromConnect = false } = {}) {
  if (trialBlocks()) return;
  closeGuide();
  closeKeymap();
  closeSettings();
  closeIconPicker();
  if (voiceTitleEl) {
    voiceTitleEl.textContent = fromConnect ? t('voice.title.connect') : t('voice.title');
  }
  if (voiceLeadEl) {
    voiceLeadEl.textContent = fromConnect ? t('voice.lead.connect') : t('voice.lead');
  }
  if (voiceModeEl) {
    voiceModeEl.textContent = fromConnect ? t('voice.mode.connect') : t('voice.mode');
  }
  voicePanel?.removeAttribute('hidden');
  refreshVoiceStatus();
  flashAction(fromConnect ? t('flash.apiSetup') : t('flash.micApi'));
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
  flashAction(t('flash.codexJump'));
  const r = await api?.beginVoiceDictation?.();
  if (!r?.ok) {
    // ⌘K가 Cursor 팔레트를 연 경우 등 — Whisper 키 설정으로 유도
    flashAction(r?.error || t('flash.codexApp'));
    openVoicePanel({ fromConnect: false });
    return;
  }
  dictationActive = true;
  state.recording = true;
  micLatched = latched;
  padEl.classList.add('recording');
  pad3d?.setRecording(true);
  flashAction(latched ? t('flash.speakTap') : t('flash.speakHold'));
}

async function stopCodexDictation({ submit = true } = {}) {
  if (!dictationActive && !state.recording) return;
  dictationActive = false;
  state.recording = false;
  micLatched = false;
  padEl.classList.remove('recording');
  pad3d?.setRecording(false);
  if (!submit) {
    flashAction(t('flash.dictationCancel'));
    await api?.endVoiceDictation?.();
    return;
  }
  flashAction(t('flash.codexSending'));
  await api?.endVoiceDictation?.();
  flashAction(t('flash.codexSent'));
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
    flashAction(ok ? t('flash.micReady') : t('flash.micPerm'));
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
  // No Whisper key → macOS dictation into the selected Agent CLI window
  if (voiceMode !== 'whisper') {
    await startCodexDictation({ latched });
    return;
  }

  const ok = await ensureMicPermission({ silent: true });
  if (!ok) {
    flashAction(t('flash.micBlocked'));
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
    flashAction(t('flash.micStream'));
    return;
  }

  micMime = pickRecorderMime();
  try {
    mediaRecorder = micMime
      ? new MediaRecorder(micStream, { mimeType: micMime })
      : new MediaRecorder(micStream);
    micMime = mediaRecorder.mimeType || micMime || 'audio/webm';
  } catch {
    flashAction(t('flash.recorderNo'));
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
  flashAction(latched ? t('flash.talkingHf') : t('flash.talking'));

  try {
    mediaRecorder.start(250);
  } catch {
    flashAction(t('flash.recFail'));
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
    flashAction(t('flash.recEmpty'));
    micFinishing = false;
    stopMicStream();
    return;
  }

  const blob = new Blob(micChunks, { type: micMime || 'audio/webm' });
  micChunks = [];
  stopMicStream();

  if (blob.size < 800) {
    flashAction(t('flash.recShort'));
    micFinishing = false;
    return;
  }

  flashAction(t('flash.whisper'));
  try {
    const base64 = await blobToBase64(blob);
    const result = await api?.transcribe?.({ base64, mimeType: blob.type || micMime });
    if (!result?.ok) {
      if (result?.code === 'NO_API_KEY') {
        flashAction(t('flash.apiNeed'));
        openVoicePanel({ fromConnect: true });
      } else {
        flashAction(result?.error || t('flash.recogFail'));
      }
      micFinishing = false;
      return;
    }
    const text = String(result.text || '').trim();
    flashAction(`🎤 ${text.slice(0, 48)}`);
    flashAction(`→ Codex · ${text.slice(0, 36)}`);
    await api?.voiceToCodex?.(text);
  } catch (e) {
    flashAction(e?.message || t('flash.voiceFail'));
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
  pad3d?.releasePress?.('mic');

  if (!process) {
    stopMicStream();
    micChunks = [];
    flashAction(t('flash.micOff'));
    return;
  }

  state.processing = true;
  padEl.classList.add('processing');
  flashAction(t('flash.saving'));

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
  if (trialBlocks()) return;
  state.pickingCmd = cmd || 'send';
  pickerTitle.textContent = t('picker.title', { cmd: state.pickingCmd });
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

function getGuideItems() {
  return [
    { section: t('guide.sec.start') },
    {
      key: '↻ / ·',
      title: t('guide.connect.title'),
      text: t('guide.connect.text'),
    },
    {
      icons: ['mic'],
      title: t('guide.mic.title'),
      text: t('guide.mic.text'),
    },
    { section: t('guide.sec.pad') },
    {
      visual: 'agents',
      title: t('guide.agents.title'),
      text: t('guide.agents.text'),
    },
    {
      key: 'Dial',
      title: 'Dial',
      text: t('guide.dial.text'),
    },
    {
      key: 'Touch',
      title: 'Touch',
      text: t('guide.touch.text'),
    },
    {
      key: 'Joy',
      title: t('guide.joy.title'),
      text: t('guide.joy.text'),
    },
    { section: t('guide.sec.tips') },
    {
      key: 'Mic',
      title: t('guide.voice.title'),
      text: t('guide.voice.text'),
    },
    {
      key: t('guide.icon.key'),
      title: t('guide.icon.title'),
      text: t('guide.icon.text'),
    },
    {
      key: '⚙',
      title: t('guide.settings.title'),
      text: t('guide.settings.text'),
    },
    {
      key: '⌨',
      title: t('guide.mod.title'),
      text: t('guide.mod.text'),
    },
    {
      key: '⌘⇧M',
      title: t('guide.hide.title'),
      text: t('guide.hide.text'),
    },
  ];
}

/** Key map — shortcuts & layer Joy (modifier-aware) */
function buildKeymapItems(g = modGlyph()) {
  return [
    { section: t('map.sec.agents') },
    {
      visual: 'agents',
      title: `${g}1 – ${g}6`,
      text: t('map.agents.text'),
    },
    { section: t('map.sec.keys') },
    {
      icons: ['lightning'],
      title: `${g}Q · Fast`,
      text: t('map.fast.text'),
    },
    {
      icons: ['check'],
      title: `${g}W · Approve`,
      text: t('map.approve.text'),
    },
    {
      icons: ['times'],
      title: `${g}E · Decline`,
      text: t('map.decline.text'),
    },
    {
      icons: ['fork'],
      title: `${g}R · Fork`,
      text: t('map.fork.text'),
    },
    {
      icons: ['mic'],
      title: `${g}D · Mic`,
      text: t('map.mic.text'),
    },
    {
      icons: ['codex'],
      title: `${g}F · Send`,
      text: t('map.send.text'),
    },
    { section: t('map.sec.controls') },
    {
      key: `${g}Tab`,
      title: t('map.touch.title'),
      text: t('map.touch.text'),
    },
    {
      key: `${g}↑↓←→`,
      title: t('map.joy.title'),
      text: t('map.joy.text'),
    },
    {
      key: 'Dial',
      title: 'Dial',
      text: 'reasoning: minimal → low → medium → high → xhigh',
    },
    { section: 'Joy · Codex' },
    {
      key: '↑ ↓',
      title: t('map.joy.codex.ud'),
      text: t('map.joy.codex.ud.text'),
    },
    {
      key: '← →',
      title: t('map.joy.codex.lr'),
      text: t('map.joy.codex.lr.text'),
    },
    { section: 'Joy · Prompts' },
    {
      key: '↑ ↓',
      title: t('map.joy.prompts.ud'),
      text: t('map.joy.prompts.ud.text'),
    },
    {
      key: '← →',
      title: t('map.joy.prompts.lr'),
      text: t('map.joy.prompts.lr.text'),
    },
    { section: 'Joy · App' },
    {
      key: '↑ ↓',
      title: t('map.joy.app.ud'),
      text: t('map.joy.app.ud.text'),
    },
    {
      key: '← →',
      title: t('map.joy.app.lr'),
      text: t('map.joy.app.lr.text'),
    },
  ];
}

const guidePanel = document.getElementById('guide-panel');
const guideBody = document.getElementById('guide-body');
const keymapPanel = document.getElementById('keymap-panel');
const keymapBody = document.getElementById('keymap-body');

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

function renderGuideList(items) {
  let html = '';
  let open = false;
  for (const item of items) {
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
  return html;
}

function openGuide() {
  if (trialBlocks()) return;
  closeIconPicker();
  closeKeymap();
  closeSettings();
  if (!guideBody || !guidePanel) return;
  guideBody.innerHTML = renderGuideList(getGuideItems());
  guidePanel.hidden = false;
}

function closeGuide() {
  if (guidePanel) guidePanel.hidden = true;
}

function syncModPickerUI() {
  const mod = state.hotkeyModifier === 'command' ? 'command' : 'shift';
  document.getElementById('mod-shift')?.classList.toggle('is-active', mod === 'shift');
  document.getElementById('mod-command')?.classList.toggle('is-active', mod === 'command');
  const hint = document.getElementById('mod-hint');
  if (hint) {
    hint.textContent =
      mod === 'command' ? t('keymap.modHint.command') : t('keymap.modHint.shift');
  }
}

function applyHotkeyModifier(mod) {
  const next = mod === 'command' ? 'command' : 'shift';
  state.hotkeyModifier = next;
  syncModPickerUI();
  if (keymapBody && keymapPanel && !keymapPanel.hidden) {
    keymapBody.innerHTML = renderGuideList(buildKeymapItems());
  }
}

function openKeymap() {
  if (trialBlocks()) return;
  closeIconPicker();
  closeGuide();
  closeSettings();
  if (!keymapBody || !keymapPanel) return;
  syncModPickerUI();
  keymapBody.innerHTML = renderGuideList(buildKeymapItems());
  keymapPanel.hidden = false;
}

function closeKeymap() {
  if (keymapPanel) keymapPanel.hidden = true;
}

/* ——— Codex CLI settings panel ——— */
const settingsPanel = document.getElementById('settings-panel');
const setSandbox = document.getElementById('set-sandbox');
const setApproval = document.getElementById('set-approval');
const setStartup = document.getElementById('set-startup');
const setTool = document.getElementById('set-tool');
const setJob = document.getElementById('set-job');
const setProxy = document.getElementById('set-proxy');
const settingsHint = document.getElementById('settings-hint');

function readSettingsForm() {
  return {
    sandbox_mode: setSandbox?.value || 'workspace-write',
    approval_policy: setApproval?.value || 'on-request',
    startup_timeout_sec: Number(setStartup?.value) || 30,
    tool_timeout_sec: Number(setTool?.value) || 60,
    job_max_runtime_seconds: Number(setJob?.value) || 1800,
    network_proxy: !!setProxy?.checked,
  };
}

function fillSettingsForm(s = {}) {
  if (setSandbox) setSandbox.value = s.sandbox_mode || 'workspace-write';
  if (setApproval) setApproval.value = s.approval_policy || 'on-request';
  if (setStartup) setStartup.value = String(s.startup_timeout_sec ?? 30);
  if (setTool) setTool.value = String(s.tool_timeout_sec ?? 60);
  if (setJob) setJob.value = String(s.job_max_runtime_seconds ?? 1800);
  if (setProxy) setProxy.checked = !!s.network_proxy;
}

async function openSettings() {
  if (trialBlocks()) return;
  closeIconPicker();
  closeGuide();
  closeKeymap();
  closeVoicePanel();
  if (!settingsPanel) return;
  try {
    const r = await api?.getCodexSettings?.();
    fillSettingsForm(r?.settings || {});
    const setLocaleEl = document.getElementById('set-locale');
    if (setLocaleEl) setLocaleEl.value = state.locale;
    if (settingsHint) {
      settingsHint.textContent = r?.meta?.profilePath
        ? t('settings.hint.profile', { profile: r.meta.profile })
        : t('settings.hint');
    }
  } catch {
    fillSettingsForm({});
  }
  settingsPanel.hidden = false;
  flashAction(t('flash.settings'));
}

function closeSettings() {
  if (settingsPanel) settingsPanel.hidden = true;
}

document.getElementById('btn-help')?.addEventListener('click', openGuide);
document.getElementById('btn-keymap')?.addEventListener('click', openKeymap);
document.getElementById('mod-shift')?.addEventListener('click', async () => {
  const r = await api?.setPadPrefs?.({ hotkeyModifier: 'shift' });
  applyHotkeyModifier(r?.hotkeyModifier || 'shift');
  flashAction(t('flash.modShift'));
});
document.getElementById('mod-command')?.addEventListener('click', async () => {
  const r = await api?.setPadPrefs?.({ hotkeyModifier: 'command' });
  applyHotkeyModifier(r?.hotkeyModifier || 'command');
  flashAction(t('flash.modCmd'));
});
document.getElementById('btn-settings')?.addEventListener('click', openSettings);
document.getElementById('guide-close')?.addEventListener('click', closeGuide);
document.getElementById('keymap-close')?.addEventListener('click', closeKeymap);
document.getElementById('settings-close')?.addEventListener('click', closeSettings);
document.getElementById('guide-to-keymap')?.addEventListener('click', openKeymap);
document.getElementById('keymap-to-guide')?.addEventListener('click', openGuide);
guidePanel?.addEventListener('click', (e) => {
  if (e.target === guidePanel) closeGuide();
});
keymapPanel?.addEventListener('click', (e) => {
  if (e.target === keymapPanel) closeKeymap();
});
settingsPanel?.addEventListener('click', (e) => {
  if (e.target === settingsPanel) closeSettings();
});
document.getElementById('settings-save')?.addEventListener('click', async () => {
  const r = await api?.saveCodexSettings?.(readSettingsForm());
  if (r?.ok) {
    fillSettingsForm(r.settings);
    flashAction(t('flash.settingsSaved'));
    if (settingsHint) {
      settingsHint.textContent = r.warning
        ? t('flash.savedWarn', { warn: r.warning })
        : t('flash.savedApply', { path: r.profile || 'agent-micro' });
    }
  } else {
    flashAction(t('flash.settingsFail'));
  }
});
document.getElementById('settings-ignore')?.addEventListener('click', async () => {
  const r = await api?.writeCodexIgnore?.();
  if (r?.canceled) {
    flashAction(t('flash.canceled'));
    return;
  }
  if (r?.ok) {
    flashAction(r.created ? t('flash.ignoreCreated') : t('flash.ignoreExists'));
    if (settingsHint) settingsHint.textContent = r.path || '';
  } else {
    flashAction(t('flash.ignoreFail'));
  }
});
document.getElementById('settings-open-config')?.addEventListener('click', () => {
  api?.openCodexConfig?.();
  flashAction(t('flash.configToml'));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeGuide();
    closeKeymap();
    closeSettings();
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
  hud.link.textContent = state.connected
    ? `Codex CLI · ${state.mode} · ${layerName}`
    : state.mode === 'offline'
      ? `demo · CLI · ${layerName}`
      : `Codex CLI · ${state.mode} · ${layerName}`;
  linkDot.classList.toggle('on', state.connected);
  linkDot.classList.toggle('demo', !state.connected);
  pad3d.setCmdActive('fast', state.fastMode);
  const forkOk =
    typeof state.canFork === 'boolean' ? state.canFork : canForkFromAgents(state.agents);
  pad3d.setCmdEnabled?.('fork', forkOk);
}

function canForkFromAgents(agents) {
  const list = Array.isArray(agents) ? agents : [];
  // UI: only disable at 6/6 — keep the key looking live otherwise
  return list.some((a) => !a || a.status === 'off') || list.length < 6;
}

function applyBridgeState(s) {
  if (!s) return;
  state.connected = !!s.connected;
  state.mode = s.mode || 'offline';
  state.linkMode = 'cli';
  state.provider = 'codex';
  state.selected = s.selected ?? state.selected;
  state.reasoningIndex = s.reasoningIndex ?? state.reasoningIndex;
  state.fastMode = !!s.fastMode;
  state.planMode = !!s.planMode;
  if (typeof s.canFork === 'boolean') state.canFork = s.canFork;
  else if (Array.isArray(s.agents)) {
    state.canFork = canForkFromAgents(s.agents);
  }
  if (Array.isArray(s.agents)) state.agents = s.agents;
  if (s.action) flashAction(s.action);
  render();
}

async function onAgent(index) {
  if (trialBlocks()) return;
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
  if (trialBlocks()) return;
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
  if (trialBlocks()) return;
  if (state.recording && !micLatched) stopRecording({ process: true });
}

async function onCmd(cmd) {
  if (trialBlocks()) return;
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
      flashAction(t('flash.newChat'));
      return;
    }
    await api?.send('Continue.');
    flashAction(t('flash.continue'));
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
  else if (cmd === 'fork') {
    if (!state.canFork) {
      flashAction(t('flash.forkFull'));
      return;
    }
    await api?.fork();
  }
}

let dialAcc = 0;
function onDialDelta(d) {
  if (trialBlocks()) return;
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
    flashAction(t('flash.reasoning', { name: REASONING[next] }));
  }
}

function onJoy(dir) {
  if (trialBlocks()) return;
  const now = Date.now();
  if (state.lastJoy.dir === dir && now - state.lastJoy.at < 450) return;
  state.lastJoy = { dir, at: now };
  const layer = LAYERS[state.layer] || LAYERS[0];
  const fn = layer.joy?.[dir];
  if (fn) fn();
  else flashAction(t('flash.joy', { dir }));
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
    onDialStart: () => flashAction(t('flash.reasoningCtrl')),
    onJoy,
    onTouch: () => {
      if (trialBlocks()) return;
      state.layer = (state.layer + 1) % LAYERS.length;
      pad3d?.setLayer?.(state.layer);
      flashAction(t('flash.layer', { name: layerDisplayName(state.layer) }));
      render();
    },
  });
  applyKeyIcons();
  render();
  flashAction(t('flash.padReady'));
} catch (err) {
  console.error(err);
  canvasHost.innerHTML = `<div style="padding:16px;font:12px/1.4 system-ui;color:#b00020;white-space:pre-wrap">3D pad failed:\n${err?.stack || err}</div>`;
  flashAction(t('flash.padError'));
}

async function connectAgent({ forceLogin = false } = {}) {
  if (trialBlocks()) {
    flashAction(t('trial.flash'));
    return;
  }
  linkDot?.classList.add('busy');
  flashAction(forceLogin ? t('flash.login') : t('flash.connecting'));
  try {
    const result = forceLogin
      ? await api?.connect?.({ forceLogin: true })
      : await api?.reconnect?.();
    state.linkMode = 'cli';
    if (result?.ok === false && result?.reason === 'missing') {
      flashAction(t('flash.missing'));
    } else if (result?.ok === false && result?.reason === 'login') {
      flashAction(t('flash.needLogin'));
    } else if (result?.ok || result === true) {
      const prompted = await maybePromptVoiceSetup(result);
      flashAction(prompted ? t('flash.cliApi') : t('flash.connected'));
    } else {
      flashAction(t('flash.demo'));
    }
  } catch (err) {
    flashAction(err?.message || t('flash.connectFail'));
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

document.getElementById('btn-reconnect')?.addEventListener('click', () => {
  connectAgent();
});

api?.onState?.(applyBridgeState);
api?.onLog?.((m) => {
  if (m) console.log('[agent]', m);
});
api?.onMicStatus?.((s) => {
  if (s?.granted) micGranted = true;
});

/** Mod+QWERDF / Tab / arrows / 1–6 — pad or our CLI context */
api?.onHotkey?.(({ cmd, phase, dir, index } = {}) => {
  if (trialBlocks()) return;
  if (!cmd) return;
  const g = modGlyph();

  if (cmd === 'agent') {
    const i = Math.max(0, Math.min(5, Number(index) || 0));
    pad3d?.simulatePress?.(`agent:${i}`);
    onAgent(i);
    flashAction(`${g}${i + 1} · Agent ${i + 1}`);
    return;
  }

  if (cmd === 'joy') {
    const d = dir || 'up';
    pad3d?.nudgeJoy?.(d);
    onJoy(d);
    flashAction(`${g}${{ up: '↑', down: '↓', left: '←', right: '→' }[d] || d}`);
    return;
  }

  if (cmd === 'touch') {
    pad3d?.simulatePress?.('touch');
    state.layer = (state.layer + 1) % LAYERS.length;
    pad3d?.setLayer?.(state.layer);
    flashAction(`${g}Tab · layer · ${layerDisplayName(state.layer)}`);
    render();
    return;
  }

  if (cmd === 'mic') {
    if (phase === 'toggle') {
      if (state.recording) {
        pad3d?.simulatePress?.('mic', { phase: 'up' });
        stopRecording({ process: true });
        flashAction(`${g}D · mic off`);
      } else {
        pad3d?.simulatePress?.('mic', { phase: 'down', sticky: true });
        startRecording({ latched: true });
        flashAction(`${g}D · mic on`);
      }
      return;
    }
    pad3d?.simulatePress?.('mic');
    onMicPress();
    return;
  }

  pad3d?.simulatePress?.(cmd);
  flashAction(`${g} · ${cmd}`);
  onCmd(cmd);
});

api?.onPadPrefs?.((prefs) => {
  if (prefs?.locale) applyLocale(prefs.locale);
  if (prefs?.hotkeyModifier) applyHotkeyModifier(prefs.hotkeyModifier);
});

api?.getPadPrefs?.().then((prefs) => {
  if (prefs?.locale) applyLocale(prefs.locale);
  else applyStaticI18n();
  if (prefs?.hotkeyModifier) applyHotkeyModifier(prefs.hotkeyModifier);
});


document.getElementById('set-locale')?.addEventListener('change', async (e) => {
  const locale = normalizeLocale(e.target.value);
  const r = await api?.setPadPrefs?.({ locale });
  applyLocale(r?.locale || locale);
  flashAction(locale === 'ko' ? t('flash.langKo') : t('flash.langEn'));
});

trialSponsorBtn?.addEventListener('click', async () => {
  const r = await api?.openSponsor?.();
  if (!r?.ok) flashAction(r?.error || t('trial.buy.none'));
  else flashAction(t('trial.buy.opened'));
});
trialCloseBtn?.addEventListener('click', () => api?.close());
trialActivateBtn?.addEventListener('click', async () => {
  const key = trialKeyInput?.value || '';
  trialActivateBtn.disabled = true;
  try {
    const r = await api?.activateLicense?.(key);
    if (!r?.ok) {
      flashAction(r?.errorKey ? t(r.errorKey) : (r?.error || t('trial.activate.fail')));
      return;
    }
    applyTrialLock(r.trial || { locked: false, expired: false, licensed: true });
    if (trialKeyInput) trialKeyInput.value = '';
    flashAction(t('trial.activate.ok'));
    api?.getState?.().then(applyBridgeState);
  } finally {
    trialActivateBtn.disabled = false;
  }
});
trialKeyInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') trialActivateBtn?.click();
});

api?.getTrialStatus?.().then((status) => {
  applyTrialLock(status);
  if (!(status?.locked ?? status?.expired)) {
    state.provider = 'codex';
    state.linkMode = 'cli';
    api?.getState?.().then(applyBridgeState);
  }
}).catch(() => {
  state.provider = 'codex';
  state.linkMode = 'cli';
  api?.getState?.().then(applyBridgeState);
});

state.provider = 'codex';
state.linkMode = 'cli';

document.getElementById('voice-close')?.addEventListener('click', async () => {
  const s = await api?.voiceStatus?.();
  if (s?.needsSetup) await api?.skipVoiceSetup?.();
  closeVoicePanel();
});
document.getElementById('voice-save')?.addEventListener('click', async () => {
  const key = voiceApiKeyEl?.value || '';
  const r = await api?.setVoiceApiKey?.(key);
  if (!r?.ok) {
    flashAction(r?.error || t('flash.saveFail'));
    return;
  }
  if (voiceApiKeyEl) voiceApiKeyEl.value = '';
  await refreshVoiceStatus();
  flashAction(r.whisperReady ? t('flash.whisperReady') : t('flash.saved'));
  closeVoicePanel();
});
document.getElementById('voice-skip')?.addEventListener('click', async () => {
  await api?.skipVoiceSetup?.();
  await refreshVoiceStatus();
  closeVoicePanel();
  flashAction(t('flash.later'));
});
document.getElementById('voice-open-keys')?.addEventListener('click', () => {
  api?.openApiKeysPage?.();
  flashAction(t('flash.keysOpened'));
});

api?.onState?.((s) => {
  if (s?.connected) maybePromptVoiceSetup();
});

/** While typing in inputs, don't treat ⇧Q/D/1… as pad shortcuts */
function isEditableEl(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  return false;
}
function syncPadHotkeySuspend() {
  api?.suspendPadHotkeys?.(isEditableEl(document.activeElement));
}
document.addEventListener('focusin', syncPadHotkeySuspend, true);
document.addEventListener('focusout', () => {
  setTimeout(syncPadHotkeySuspend, 0);
}, true);

flashAction(t('flash.codexCli'));
applyStaticI18n();
