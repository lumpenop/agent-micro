import { createPad3D } from './pad3d.mjs';
import {
  DEFAULT_KEY_ICONS,
  isPickerIcon,
  pickerIconIds,
  iconMarkup,
  getCustomIcons,
  getCustomIcon,
  setCustomIcons,
  upsertCustomIcon,
  removeCustomIcon,
  isCustomIcon,
  resolveIconDef,
} from './icons.mjs';

const { t: tRaw, normalizeLocale } = window.agentI18n || {
  t: (_loc, key) => key,
  normalizeLocale: (l) => (l === 'ko' ? 'ko' : 'en'),
};

const REASONING = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const QUICK_MODEL = 'gpt-5.6-terra';
const DEEP_MODEL = 'gpt-5.6-sol';
const api = window.codexDesktop;
const STORAGE_KEY = 'agent-micro-key-icons-v1';
const CUSTOM_ICONS_KEY = 'agent-micro-custom-icons-v1';
const MAX_CUSTOM_ICONS = 32;

/**
 * Joystick layers (Touch cycles these):
 * - Codex: CLI session control (plan, new chat, agent slot history)
 * - Prompts: inject canned skills (review / docs / refactor / debug)
 * - Tools: active-session model picker and selected-workspace dev server
 */
const LAYERS = [
  {
    name: 'Codex',
    joy: {
      up: () => api?.togglePlan(),
      down: () => api?.newChat(),
      left: () => api?.desktop('agentPrev'),
      right: () => api?.desktop('agentNext'),
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
    name: 'Tools',
    joy: {
      up: () => toggleQuickDeepModel(),
      down: () => toggleCurrentDevServer(),
      left: () => flashAction(t('flash.toolsHint')),
      right: () => sendManualContinue(),
    },
  },
];

function layerDisplayName(layerIndex) {
  return LAYERS[layerIndex]?.name || `L${layerIndex + 1}`;
}

function loadCustomIconsFromStorage() {
  try {
    const list = JSON.parse(localStorage.getItem(CUSTOM_ICONS_KEY) || '[]');
    setCustomIcons(Array.isArray(list) ? list : []);
  } catch {
    setCustomIcons([]);
  }
}

function saveCustomIconsToStorage() {
  localStorage.setItem(CUSTOM_ICONS_KEY, JSON.stringify(getCustomIcons()));
}

function loadKeyIcons() {
  loadCustomIconsFromStorage();
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
  // Migrate old Codex brand mark → Lucide send
  if (stored.send === 'codex' || stored.send === 'send') stored.send = 'terminal';
  const merged = { ...DEFAULT_KEY_ICONS, ...stored };
  for (const [cmd, id] of Object.entries(merged)) {
    if (!isPickerIcon(id)) merged[cmd] = DEFAULT_KEY_ICONS[cmd];
  }
  return merged;
}

function saveKeyIcons(map) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

async function fileToCustomIcon(file) {
  const id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const label = (file.name || 'Custom').replace(/\.[^.]+$/, '').slice(0, 24) || 'Custom';
  const isSvg =
    file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '');

  if (isSvg) {
    const text = await file.text();
    if (/<script/i.test(text) || /\bon\w+\s*=/i.test(text)) {
      throw new Error('unsafe svg');
    }
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
    if (dataUrl.length > 220_000) throw new Error('too large');
    return { id, label, dataUrl };
  }

  if (!file.type.startsWith('image/')) throw new Error('not image');
  const bitmap = await createImageBitmap(file);
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const scale = Math.min(size / bitmap.width, size / bitmap.height) * 0.86;
  const dw = bitmap.width * scale;
  const dh = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - dw) / 2, (size - dh) / 2, dw, dh);
  bitmap.close?.();
  const dataUrl = c.toDataURL('image/png');
  if (dataUrl.length > 220_000) throw new Error('too large');
  return { id, label, dataUrl };
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
  devServerRunning: false,
  devServerCwd: '',
  devServerCommand: '',
  devServerKind: '',
  agentModelModes: Array.from({ length: 6 }, () => 'deep'),
  autoContinueEnabled: false,
  autoContinueDelaySec: 30,
  autoContinueMaxRuns: 1,
  autoContinueCounts: Array.from({ length: 6 }, () => 0),
  autoContinueIssued: Array.from({ length: 6 }, () => false),
  autoContinueTimers: Array.from({ length: 6 }, () => null),
  lastJoy: { dir: null, at: 0 },
  agents: Array.from({ length: 6 }, () => ({ name: '—', status: 'off' })),
  keyIcons: loadKeyIcons(),
  pickingCmd: null,
  /** @type {'command' | 'option' | 'control' | 'capslock'} */
  hotkeyModifier: 'command',
  canFork: true,
  trialExpired: false,
  /** Not logged into Codex CLI — pad locked until login */
  needsCodexLogin: false,
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
  switch (mod) {
    case 'option':
      return '⌥';
    case 'control':
      return '⌃';
    case 'capslock':
      return '⇪';
    case 'command':
    default:
      return '⌘';
  }
}

const HOTKEY_MODS = ['command', 'option', 'control', 'capslock'];

function normalizeHotkeyMod(mod) {
  const m = String(mod || '').toLowerCase();
  if (HOTKEY_MODS.includes(m)) return m;
  if (m === 'shift' || m === 'cmd' || m === 'meta') return m === 'shift' ? 'command' : 'command';
  if (m === 'alt' || m === 'opt') return 'option';
  if (m === 'ctrl') return 'control';
  if (m === 'caps' || m === 'caps-lock') return 'capslock';
  return 'command';
}

const padEl = document.getElementById('pad');
const canvasHost = document.getElementById('pad-canvas');
const linkDot = document.getElementById('link-dot');
const shellEl = document.getElementById('shell');
const gitButton = document.getElementById('btn-git');
const gitPanel = document.getElementById('git-side-panel');
const gitClose = document.getElementById('git-side-close');
const gitRefresh = document.getElementById('git-refresh');
let gitRefreshTimer = null;
const trialLockEl = document.getElementById('trial-lock');
const trialSponsorBtn = document.getElementById('trial-sponsor');
const trialCloseBtn = document.getElementById('trial-close');
const trialHintEl = document.getElementById('trial-lock-hint');
const trialKeyInput = document.getElementById('trial-license-key');
const trialActivateBtn = document.getElementById('trial-activate');
const hud = {
  link: document.getElementById('hud-link'),
  task: document.getElementById('hud-task'),
  folder: document.getElementById('hud-folder'),
  status: document.getElementById('hud-status'),
  reason: document.getElementById('hud-reason'),
  action: document.getElementById('hud-action'),
  model: document.getElementById('hud-model'),
  modelChange: document.getElementById('hud-model-change'),
  continueStatus: document.getElementById('hud-continue-status'),
  continueButton: document.getElementById('hud-continue'),
};

async function setGitPanelOpen(open) {
  const next = !!open;
  if (gitPanel) gitPanel.hidden = !next;
  shellEl?.classList.toggle('git-open', next);
  gitButton?.classList.toggle('is-active', next);
  gitButton?.setAttribute('aria-expanded', String(next));
  await api?.setGitPanel?.(next);
  if (gitRefreshTimer) clearInterval(gitRefreshTimer);
  gitRefreshTimer = null;
  if (next) {
    await refreshGitStatus();
    gitRefreshTimer = setInterval(refreshGitStatus, 4000);
  }
}

async function refreshGitStatus() {
  if (!gitPanel || gitPanel.hidden) return;
  const list = document.getElementById('git-change-list');
  gitRefresh?.classList.add('is-loading');
  const result = await api?.getGitStatus?.();
  gitRefresh?.classList.remove('is-loading');
  const branch = document.getElementById('git-branch-name');
  if (branch) branch.textContent = result?.ok ? `${result.branch}${result.tracking ? ` · ${result.tracking}` : ''}` : 'Not a Git repo';
  if (!list) return;
  list.replaceChildren();
  if (!result?.ok) {
    const empty = document.createElement('div'); empty.className = 'git-empty'; empty.textContent = result?.error || 'Git status unavailable'; list.append(empty); return;
  }
  if (!result.files?.length) {
    const empty = document.createElement('div'); empty.className = 'git-empty'; empty.textContent = '✓ Working tree clean'; list.append(empty); return;
  }
  for (const file of result.files) {
    const row = document.createElement('div'); row.className = 'git-change';
    const code = document.createElement('span'); code.className = 'git-change-code'; code.textContent = file.status;
    const name = document.createElement('span'); name.className = 'git-change-path'; name.textContent = file.path; name.title = file.path;
    row.append(code, name); list.append(row);
  }
}

gitButton?.addEventListener('click', () => setGitPanelOpen(!!gitPanel?.hidden));
gitClose?.addEventListener('click', () => setGitPanelOpen(false));
gitRefresh?.addEventListener('click', refreshGitStatus);

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
  hideLoginGate();
  closeGuide();
  closeKeymap();
  closeSettings();
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

function loginBlocks() {
  return !!state.needsCodexLogin;
}

/** Pad / hotkeys blocked while trial expired or Codex login gate is up */
function padBlocks() {
  return trialBlocks() || loginBlocks();
}

const loginGateEl = document.getElementById('codex-login-gate');
const loginGateBtn = document.getElementById('login-gate-btn');
const loginGateHintEl = document.getElementById('login-gate-hint');

function showLoginGate({ missing = false } = {}) {
  state.needsCodexLogin = true;
  shellEl?.classList.add('login-required');
  closeGuide();
  closeKeymap();
  closeSettings();
  closeIconPicker();
  loginGateEl?.removeAttribute('hidden');
  if (loginGateHintEl) {
    loginGateHintEl.textContent = missing ? t('loginGate.missing') : t('loginGate.hint');
  }
  flashAction(t('loginGate.flash'));
}

function hideLoginGate() {
  state.needsCodexLogin = false;
  shellEl?.classList.remove('login-required');
  loginGateEl?.setAttribute('hidden', '');
}

async function ensureCodexLoginOnEntry() {
  if (trialBlocks()) return;
  try {
    const login = await api?.loginStatus?.();
    if (!login?.hasCodex) {
      showLoginGate({ missing: true });
      return;
    }
    if (login.loggedIn) {
      hideLoginGate();
      await connectAgent({ forceLogin: false });
      return;
    }
    showLoginGate();
  } catch {
    showLoginGate();
  }
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
let dictationActive = false;
/** True while beginVoiceDictation IPC is in flight (hold-release race). */
let micStarting = false;
let micCancelStart = false;
let pendingMicLatch = false;
let micStartGen = 0;
const voiceSink = document.getElementById('voice-sink');
let voiceStream = null;
let voiceAudioContext = null;
let voiceSource = null;
let voiceProcessor = null;
let voicePcm = [];
let voiceSampleRate = 48000;

function encodeVoiceWav(chunks, sampleRate) {
  const rawLength = chunks.reduce((n, x) => n + x.length, 0);
  const raw = new Float32Array(rawLength);
  let cursor = 0;
  for (const chunk of chunks) { raw.set(chunk, cursor); cursor += chunk.length; }
  // Do not reject or trim quiet recordings here: laptop/headset input levels vary
  // greatly. Whisper and the transcript filters handle silence/hallucinations.
  const samples = raw;
  const length = samples.length;
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const value of samples) {
    const sample = Math.max(-1, Math.min(1, value));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true); offset += 2;
  }
  return new Uint8Array(buffer);
}

function armVoiceSink({ clear = true } = {}) {
  if (!voiceSink) return;
  if (clear) voiceSink.value = '';
  voiceSink.style.pointerEvents = 'auto';
  voiceSink.focus({ preventScroll: true });
  try {
    const n = voiceSink.value.length;
    voiceSink.setSelectionRange(n, n);
  } catch {
    /* ignore */
  }
}

function disarmVoiceSink() {
  if (!voiceSink) return;
  const text = String(voiceSink.value || '').trim();
  voiceSink.blur();
  voiceSink.style.pointerEvents = 'none';
  voiceSink.value = '';
  return text;
}

/** Mic = real audio capture → Apple Speech → selected Agent CLI. */
async function startRecording({ latched = false } = {}) {
  if (dictationActive || micStarting) return;
  if (padBlocks()) return;
  const gen = ++micStartGen;
  micStarting = true;
  micCancelStart = false;
  pendingMicLatch = latched;
  flashAction(t('flash.codexJump'));
  const prep = await api?.prepareVoiceCapture?.();
  if (!prep?.ok) {
    micStarting = false;
    flashAction(prep?.error || t('flash.codexApp'));
    return;
  }
  if (gen !== micStartGen) {
    micStarting = false;
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    voiceStream = stream;
    voicePcm = [];
    voiceAudioContext = new AudioContext();
    voiceSampleRate = voiceAudioContext.sampleRate;
    voiceSource = voiceAudioContext.createMediaStreamSource(stream);
    voiceProcessor = voiceAudioContext.createScriptProcessor(4096, 1, 1);
    voiceProcessor.onaudioprocess = (event) => voicePcm.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    voiceSource.connect(voiceProcessor);
    voiceProcessor.connect(voiceAudioContext.destination);
  } catch (e) {
    stream?.getTracks?.().forEach((track) => track.stop());
    micStarting = false;
    flashAction(e?.name === 'NotAllowedError' ? '마이크 권한을 허용하세요' : String(e?.message || e));
    return;
  }
  if (gen !== micStartGen) {
    micStarting = false;
    return;
  }
  dictationActive = true;
  state.recording = true;
  micLatched = latched;
  micStarting = false;
  padEl.classList.add('recording');
  pad3d?.setRecording(true);
  flashAction(latched ? t('flash.speakTap') : t('flash.speakHold'));

  // Hold released while start was still in flight → finish now
  if (micCancelStart && !latched) {
    micCancelStart = false;
    await stopRecording({ process: true });
  }
}

async function stopRecording({ process = true } = {}) {
  if (!dictationActive && !state.recording) {
    if (micStarting) micCancelStart = true;
    return;
  }
  dictationActive = false;
  state.recording = false;
  micLatched = false;
  pendingMicLatch = false;
  padEl.classList.remove('recording');
  pad3d?.setRecording(false);
  pad3d?.releasePress?.('mic');
  if (!process) {
    flashAction(t('flash.dictationCancel'));
    voiceProcessor?.disconnect(); voiceSource?.disconnect(); await voiceAudioContext?.close();
    voiceStream?.getTracks?.().forEach((track) => track.stop());
    voiceAudioContext = null; voiceSource = null; voiceProcessor = null; voiceStream = null; voicePcm = [];
    return;
  }
  flashAction(t('flash.codexSending'));
  voiceProcessor?.disconnect(); voiceSource?.disconnect(); await voiceAudioContext?.close();
  voiceStream?.getTracks?.().forEach((track) => track.stop());
  const bytes = encodeVoiceWav(voicePcm, voiceSampleRate);
  voiceAudioContext = null; voiceSource = null; voiceProcessor = null; voiceStream = null; voicePcm = [];
  if (!bytes.length) { flashAction('음성이 너무 작거나 짧습니다'); return; }
  const sent = await api?.transcribeVoiceAudio?.(bytes, 'audio/wav');
  flashAction(sent?.ok ? t('flash.codexSent') : sent?.error || t('flash.codexApp'));
}

function applyKeyIcons() {
  if (!pad3d) return;
  Object.entries(state.keyIcons).forEach(([cmd, id]) => {
    pad3d.setKeyIcon(cmd, id);
  });
}

let pendingCustomIcon = null;

const iconAddForm = document.getElementById('icon-add-form');
const iconAddPreview = document.getElementById('icon-add-preview');
const iconAddName = document.getElementById('icon-add-name');
const iconPickerScroll = document.getElementById('icon-picker-scroll');
const iconOnlineForm = document.getElementById('icon-online-search');
const iconOnlineQuery = document.getElementById('icon-online-query');
const iconOnlineStatus = document.getElementById('icon-online-status');
const iconOnlineGrid = document.getElementById('icon-online-grid');
const RECOMMENDED_AGENT_ICONS = ['simple-icons:openai', 'simple-icons:claude', 'simple-icons:anthropic', 'simple-icons:googlegemini', 'simple-icons:cursor', 'simple-icons:githubcopilot', 'simple-icons:windsurf', 'simple-icons:perplexity', 'simple-icons:mistralai'];

function showIconGrid() {
  if (pickerGrid) pickerGrid.hidden = false;
  if (iconOnlineForm) iconOnlineForm.hidden = false;
  if (iconOnlineStatus) iconOnlineStatus.hidden = false;
  if (iconOnlineGrid) iconOnlineGrid.hidden = !iconOnlineGrid.childElementCount;
  if (iconAddForm) iconAddForm.hidden = true;
  pendingCustomIcon = null;
  if (iconAddPreview) iconAddPreview.removeAttribute('src');
  if (iconAddName) iconAddName.value = '';
}

function showIconAddForm(entry) {
  pendingCustomIcon = entry;
  if (pickerGrid) pickerGrid.hidden = true;
  if (iconOnlineForm) iconOnlineForm.hidden = true;
  if (iconOnlineStatus) iconOnlineStatus.hidden = true;
  if (iconOnlineGrid) iconOnlineGrid.hidden = true;
  if (iconAddForm) iconAddForm.hidden = false;
  if (iconAddPreview) iconAddPreview.src = entry.dataUrl;
  if (iconAddName) {
    iconAddName.value = entry.label || '';
    iconAddName.focus();
    iconAddName.select();
  }
  pickerTitle.textContent = t('picker.nameTitle');
  iconPickerScroll?.scrollTo?.(0, 0);
}

function renderIconPickerGrid() {
  showIconGrid();
  if (iconOnlineGrid && !iconOnlineGrid.childElementCount) {
    renderOnlineIconResults(RECOMMENDED_AGENT_ICONS);
    if (iconOnlineStatus) iconOnlineStatus.textContent = t('picker.onlineRecommended');
  }
  if (state.pickingCmd) {
    pickerTitle.textContent = t('picker.title', { cmd: state.pickingCmd });
  }
  const current = state.keyIcons[state.pickingCmd];
  const tiles = pickerIconIds()
    .map((id) => {
      const def = resolveIconDef(id);
      if (!def) return '';
      const custom = isCustomIcon(id);
      return `<button type="button" class="icon-pick${id === current ? ' active' : ''}${custom ? ' icon-pick-custom' : ''}" data-icon="${id}" title="${def.label}${custom ? ` · ${t('picker.customHint')}` : ''}">
      ${iconMarkup(id)}
      <span>${def.label}</span>
      ${custom ? `<span class="icon-pick-del" data-del="${id}" title="${t('picker.remove')}">×</span>` : ''}
    </button>`;
    })
    .join('');
  const addTile = `<button type="button" class="icon-pick icon-pick-add" data-add="1" title="${t('picker.add')}">
      <span class="icon-pick-plus">+</span>
      <span>${t('picker.add')}</span>
    </button>`;
  pickerGrid.innerHTML = tiles + addTile;
}

function renderOnlineIconResults(ids) {
  if (!iconOnlineGrid) return;
  iconOnlineGrid.replaceChildren();
  for (const id of ids) {
    const [prefix, name] = id.split(':');
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'icon-pick'; button.dataset.onlineIcon = id; button.title = id;
    const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.src = `https://api.iconify.design/${prefix}/${name}.svg`;
    const label = document.createElement('span'); label.textContent = name.replace(/-/g, ' ');
    button.append(img, label); iconOnlineGrid.append(button);
  }
  iconOnlineGrid.hidden = !ids.length;
}

iconOnlineForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = iconOnlineQuery?.value?.trim() || '';
  if (iconOnlineStatus) iconOnlineStatus.textContent = t('picker.onlineSearching');
  if (iconOnlineGrid) { iconOnlineGrid.hidden = true; iconOnlineGrid.replaceChildren(); }
  const result = await api?.searchOnlineIcons?.(query);
  if (!result?.ok) { if (iconOnlineStatus) iconOnlineStatus.textContent = result?.error || t('picker.onlineFail'); return; }
  renderOnlineIconResults(result.icons || []);
  if (iconOnlineStatus) iconOnlineStatus.textContent = result.icons?.length ? t('picker.onlineResults', { count: result.icons.length }) : t('picker.onlineEmpty');
});

iconOnlineGrid?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-online-icon]');
  if (!button || button.disabled) return;
  if (getCustomIcons().length >= MAX_CUSTOM_ICONS) { flashAction(t('picker.addFull')); return; }
  button.disabled = true;
  if (iconOnlineStatus) iconOnlineStatus.textContent = t('picker.onlineSearching');
  const result = await api?.fetchOnlineIcon?.(button.dataset.onlineIcon);
  button.disabled = false;
  if (!result?.ok) { if (iconOnlineStatus) iconOnlineStatus.textContent = result?.error || t('picker.onlineFail'); return; }
  showIconAddForm({ id: `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, label: result.label, dataUrl: result.dataUrl });
});

function openIconPicker(cmd) {
  if (padBlocks()) return;
  state.pickingCmd = cmd || 'send';
  renderIconPickerGrid();
  picker.hidden = false;
}

function closeIconPicker() {
  state.pickingCmd = null;
  pendingCustomIcon = null;
  showIconGrid();
  picker.hidden = true;
}

function commitPendingCustomIcon() {
  if (!pendingCustomIcon) return;
  const name = (iconAddName?.value || '').trim().slice(0, 24);
  if (!name) {
    flashAction(t('picker.nameRequired'));
    iconAddName?.focus();
    return;
  }
  const entry = { ...pendingCustomIcon, label: name };
  upsertCustomIcon(entry);
  saveCustomIconsToStorage();
  if (state.pickingCmd) {
    state.keyIcons[state.pickingCmd] = entry.id;
    saveKeyIcons(state.keyIcons);
    pad3d?.setKeyIcon(state.pickingCmd, entry.id);
  }
  flashAction(t('picker.added', { name: entry.label }));
  pendingCustomIcon = null;
  renderIconPickerGrid();
}

pickerGrid.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.preventDefault();
    e.stopPropagation();
    const id = del.dataset.del;
    if (!id || !isCustomIcon(id)) return;
    removeCustomIcon(id);
    saveCustomIconsToStorage();
    // Reset any keys still using the removed icon
    let dirty = false;
    for (const [cmd, iconId] of Object.entries(state.keyIcons)) {
      if (iconId === id) {
        state.keyIcons[cmd] = DEFAULT_KEY_ICONS[cmd] || 'send';
        dirty = true;
        pad3d?.setKeyIcon(cmd, state.keyIcons[cmd]);
      }
    }
    if (dirty) saveKeyIcons(state.keyIcons);
    flashAction(t('picker.removed'));
    renderIconPickerGrid();
    return;
  }

  const add = e.target.closest('[data-add]');
  if (add) {
    e.preventDefault();
    document.getElementById('icon-picker-file')?.click();
    return;
  }

  const btn = e.target.closest('.icon-pick');
  if (!btn || !state.pickingCmd || btn.dataset.add) return;
  const id = btn.dataset.icon;
  if (!id || !isPickerIcon(id)) return;
  state.keyIcons[state.pickingCmd] = id;
  saveKeyIcons(state.keyIcons);
  pad3d?.setKeyIcon(state.pickingCmd, id);
  const label = resolveIconDef(id)?.label || getCustomIcon(id)?.label || id;
  flashAction(`icon · ${label}`);
  closeIconPicker();
});

document.getElementById('icon-picker-file')?.addEventListener('change', async (e) => {
  const input = e.target;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (getCustomIcons().length >= MAX_CUSTOM_ICONS) {
    flashAction(t('picker.addFull'));
    return;
  }
  try {
    const entry = await fileToCustomIcon(file);
    showIconAddForm(entry);
  } catch (err) {
    flashAction(t('picker.addFail'));
    console.warn('[icons] add failed', err);
  }
});

document.getElementById('icon-add-confirm')?.addEventListener('click', () => {
  commitPendingCustomIcon();
});
document.getElementById('icon-add-cancel')?.addEventListener('click', () => {
  pendingCustomIcon = null;
  renderIconPickerGrid();
});
iconAddName?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitPendingCustomIcon();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    pendingCustomIcon = null;
    renderIconPickerGrid();
  }
});

document.getElementById('icon-picker-close')?.addEventListener('click', closeIconPicker);
picker?.addEventListener('click', (e) => {
  if (e.target === picker) closeIconPicker();
});

/** Inline SVGs for guide key badges — avoid unicode glyphs that tofu in UI fonts */
const GUIDE_MARK_SVG = {
  reconnect: `<svg class="icon-svg icon-stroke" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`,
  settings: `<svg class="icon-svg icon-stroke" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
  keyboard: `<svg class="icon-svg icon-stroke" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M6 12h.01"/><path d="M10 12h.01"/><path d="M14 12h.01"/><path d="M18 12h.01"/><path d="M7 16h10"/></svg>`,
  // Filled triangles — much clearer than thin unicode ↑↓←→
  up: `<svg class="icon-svg icon-fill" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M12 5.2 20.4 18.1a1.1 1.1 0 0 1-.95 1.7H4.55a1.1 1.1 0 0 1-.95-1.7L12 5.2z"/></svg>`,
  down: `<svg class="icon-svg icon-fill" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M12 18.8 3.6 5.9a1.1 1.1 0 0 1 .95-1.7h14.9a1.1 1.1 0 0 1 .95 1.7L12 18.8z"/></svg>`,
  left: `<svg class="icon-svg icon-fill" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M5.2 12 18.1 3.6a1.1 1.1 0 0 1 1.7.95v14.9a1.1 1.1 0 0 1-1.7.95L5.2 12z"/></svg>`,
  right: `<svg class="icon-svg icon-fill" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M18.8 12 5.9 20.4a1.1 1.1 0 0 1-1.7-.95V4.55a1.1 1.1 0 0 1 1.7-.95L18.8 12z"/></svg>`,
};

function getGuideItems() {
  return [
    { section: t('guide.sec.start') },
    {
      marks: ['reconnect', 'slash', 'dot'],
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
      icons: ['mic'],
      title: t('guide.voice.title'),
      text: t('guide.voice.text'),
    },
    {
      key: t('guide.icon.key'),
      title: t('guide.icon.title'),
      text: t('guide.icon.text'),
    },
    {
      marks: ['settings'],
      title: t('guide.settings.title'),
      text: t('guide.settings.text'),
    },
    {
      marks: ['keyboard'],
      title: t('guide.mod.title'),
      text: t('guide.mod.text'),
    },
    {
      key: '⌘⇧M',
      keyLarge: true,
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
      icons: ['terminal'],
      title: `${g}F · DEV`,
      text: t('map.send.text'),
    },
    { section: t('map.sec.controls') },
    {
      marks: ['mod', 'tab'],
      stack: true,
      keyLarge: true,
      title: t('map.touch.title'),
      text: t('map.touch.text'),
    },
    {
      marks: ['mod', 'joyPad'],
      stack: true,
      title: t('map.joy.title'),
      text: t('map.joy.text'),
    },
    {
      marks: ['dial'],
      title: 'Dial',
      text: 'reasoning: minimal → low → medium → high → xhigh',
    },
    { section: 'Joy · Codex' },
    {
      marks: ['up', 'down'],
      title: t('map.joy.codex.ud'),
      text: t('map.joy.codex.ud.text'),
    },
    {
      marks: ['left', 'right'],
      title: t('map.joy.codex.lr'),
      text: t('map.joy.codex.lr.text'),
    },
    { section: 'Joy · Prompts' },
    {
      marks: ['up', 'down'],
      title: t('map.joy.prompts.ud'),
      text: t('map.joy.prompts.ud.text'),
    },
    {
      marks: ['left', 'right'],
      title: t('map.joy.prompts.lr'),
      text: t('map.joy.prompts.lr.text'),
    },
    { section: 'Joy · Tools' },
    {
      marks: ['up', 'down'],
      title: t('map.joy.tools.ud'),
      text: t('map.joy.tools.ud.text'),
    },
    {
      marks: ['left', 'right'],
      title: t('map.joy.tools.lr'),
      text: t('map.joy.tools.lr.text'),
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

function guideArrowIco(id) {
  const svg = GUIDE_MARK_SVG[id];
  return svg ? `<span class="guide-ico guide-ico--arrow">${svg}</span>` : '';
}

function guideMarksHtml(marks) {
  return marks
    .map((id) => {
      if (id === 'slash') return '<span class="guide-key-slash">/</span>';
      if (id === 'dot') return '<span class="guide-key-dot" aria-hidden="true"></span>';
      if (id === 'mod') return `<span class="guide-key-mod">${modGlyph()}</span>`;
      if (id === 'tab') return '<span class="guide-key-word">Tab</span>';
      if (id === 'dial') return '<span class="guide-key-word guide-key-word--lg">Dial</span>';
      if (id === 'joyPad') {
        return `<span class="guide-joy-pad" aria-hidden="true">
          <span></span>${guideArrowIco('up')}<span></span>
          ${guideArrowIco('left')}<span></span>${guideArrowIco('right')}
          <span></span>${guideArrowIco('down')}<span></span>
        </span>`;
      }
      const svg = GUIDE_MARK_SVG[id];
      if (!svg) return '';
      const arrow = id === 'up' || id === 'down' || id === 'left' || id === 'right';
      return `<span class="guide-ico${arrow ? ' guide-ico--arrow' : ''}">${svg}</span>`;
    })
    .join('');
}

function formatGuideKeyLabel(key) {
  const s = String(key || '');
  // ⌘⇧M / ⇧Tab → stack with + between each piece
  const chord = s.match(/^([⌘⇧⌃⌥]+)(.+)$/u);
  if (chord && !/\n/.test(s) && chord[2].length <= 4) {
    const parts = [...chord[1], chord[2]];
    const plus = '<span class="guide-chord-plus">+</span>';
    if (parts.length >= 3) {
      const top = parts.slice(0, -1).join(plus);
      const bot = `${plus}${parts[parts.length - 1]}`;
      return `<span class="guide-chord guide-chord--plus"><span class="guide-chord-mods">${top}</span><span class="guide-chord-key">${bot}</span></span>`;
    }
    return `<span class="guide-chord guide-chord--plus"><span class="guide-chord-mods">${parts[0]}</span><span class="guide-chord-key">${plus}${parts[1]}</span></span>`;
  }
  const html = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
  return html;
}

/** single = one glyph in the badge · multi = 2+ pieces / joy pad / arrow pair */
function guideBadgeDensity(item) {
  if (item.icons?.length) return item.icons.length === 1 ? 'single' : 'multi';
  if (item.marks?.length) {
    if (item.marks.includes('joyPad')) return 'multi';
    return item.marks.length === 1 ? 'single' : 'multi';
  }
  return null;
}

function guideKeyHtml(item) {
  if (item.visual === 'agents') return guideAgentsVisual();
  if (item.marks?.length) {
    const density = guideBadgeDensity(item);
    const arrowPair =
      item.marks.length === 2 &&
      item.marks.every((m) => m === 'up' || m === 'down' || m === 'left' || m === 'right');
    const cls = [
      'guide-item-key',
      'guide-item-key--icons',
      density === 'single' ? 'guide-item-key--single' : 'guide-item-key--multi',
      item.stack ? 'guide-item-key--stack' : '',
      arrowPair ? 'guide-item-key--arrow-pair' : '',
      item.keyLarge ? 'guide-item-key--chord-lg' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return `<div class="${cls}">${guideMarksHtml(item.marks)}</div>`;
  }
  if (item.icons?.length) {
    const density = guideBadgeDensity(item);
    const icons = item.icons
      .map((id) => `<span class="guide-ico">${iconMarkup(id)}</span>`)
      .join('<span class="guide-ico-sep" aria-hidden="true"></span>');
    const densCls = density === 'single' ? 'guide-item-key--single' : 'guide-item-key--multi';
    return `<div class="guide-item-key guide-item-key--icons ${densCls}">${icons}</div>`;
  }
  const raw = String(item.key || '');
  const wrap = raw.includes('\n') || raw.length > 7;
  const cls = [
    'guide-item-key',
    wrap ? 'guide-item-key--wrap' : '',
    item.keyLarge ? 'guide-item-key--chord-lg' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<div class="${cls}">${formatGuideKeyLabel(raw)}</div>`;
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
  if (padBlocks()) return;
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
  const mod = normalizeHotkeyMod(state.hotkeyModifier);
  for (const id of HOTKEY_MODS) {
    document.getElementById(`mod-${id}`)?.classList.toggle('is-active', mod === id);
  }
  const hint = document.getElementById('mod-hint');
  if (hint) {
    hint.textContent = t(`keymap.modHint.${mod}`);
  }
}

function applyHotkeyModifier(mod) {
  state.hotkeyModifier = normalizeHotkeyMod(mod);
  syncModPickerUI();
  if (keymapBody && keymapPanel && !keymapPanel.hidden) {
    keymapBody.innerHTML = renderGuideList(buildKeymapItems());
  }
}

function openKeymap() {
  if (padBlocks()) return;
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
const mcpPanel = document.getElementById('mcp-panel');
const mcpList = document.getElementById('mcp-list');
const skillsPanel = document.getElementById('skills-panel');
const skillsList = document.getElementById('skills-list');
const skillEditSelect = document.getElementById('skill-edit-select');
const skillEditName = document.getElementById('skill-edit-name');
const skillEditDescription = document.getElementById('skill-edit-description');
const skillEditInstructions = document.getElementById('skill-edit-instructions');
let personalSkills = [];
let editingSkillOriginal = '';
const setWorkingDirectory = document.getElementById('set-working-directory');
const setWritableRoots = document.getElementById('set-writable-roots');
const setWorkspaceNetwork = document.getElementById('set-workspace-network');
const setMaxThreads = document.getElementById('set-max-threads');
const setMaxDepth = document.getElementById('set-max-depth');
const setInterruptMessage = document.getElementById('set-interrupt-message');
const setResourcePreset = document.getElementById('set-resource-preset');
const setRolloutBudget = document.getElementById('set-rollout-budget');
const setRolloutLimit = document.getElementById('set-rollout-limit');
const setRolloutReminder = document.getElementById('set-rollout-reminder');
const setCompactLimit = document.getElementById('set-compact-limit');
const setToolOutputLimit = document.getElementById('set-tool-output-limit');
const setRamWarning = document.getElementById('set-ram-warning');
const setRamStatus = document.getElementById('set-ram-status');
const setAgentRole = document.getElementById('set-agent-role');
const setAgentEditor = document.getElementById('set-agent-editor');
const setAgentEnabled = document.getElementById('set-agent-enabled');
const setAgentName = document.getElementById('set-agent-name');
const setAgentDescription = document.getElementById('set-agent-description');
const setAgentInstructions = document.getElementById('set-agent-instructions');
const setAgentModel = document.getElementById('set-agent-model');
const setAgentReasoning = document.getElementById('set-agent-reasoning');
const setPlanReasoning = document.getElementById('set-plan-reasoning');
const setReasoningSummary = document.getElementById('set-reasoning-summary');
const setVerbosity = document.getElementById('set-verbosity');
const setHooksEnabled = document.getElementById('set-hooks-enabled');
const setPreventSleep = document.getElementById('set-prevent-sleep');
let agentRoles = [];
const setModel = document.getElementById('set-model');
const setReasoning = document.getElementById('set-reasoning');
const setPersonality = document.getElementById('set-personality');
const setWebSearch = document.getElementById('set-web-search');
const setSandbox = document.getElementById('set-sandbox');
const setApproval = document.getElementById('set-approval');
const setStartup = document.getElementById('set-startup');
const setTool = document.getElementById('set-tool');
const setJob = document.getElementById('set-job');
const setProxy = document.getElementById('set-proxy');
const settingsHint = document.getElementById('settings-hint');
const settingsSearch = document.getElementById('settings-search');
const settingsBackupSelect = document.getElementById('settings-backup-select');
const setCodexStatusEl = document.getElementById('set-codex-status');
const setLicenseStatusEl = document.getElementById('set-license-status');
const settingsLicenseKeyEl = document.getElementById('settings-license-key');
const settingsCodexLoginBtn = document.getElementById('settings-codex-login');
const settingsLicenseActivateBtn = document.getElementById('settings-license-activate');
const settingsLicenseBuyBtn = document.getElementById('settings-license-buy');
const setAutoContinue = document.getElementById('set-auto-continue');
const setAutoContinueDelay = document.getElementById('set-auto-continue-delay');
const setAutoContinueMax = document.getElementById('set-auto-continue-max');

function fillAutoContinuePrefs(prefs = {}) {
  if (setAutoContinue) setAutoContinue.checked = prefs.autoContinueEnabled === true;
  if (setAutoContinueDelay) setAutoContinueDelay.value = String(prefs.autoContinueDelaySec ?? 30);
  if (setAutoContinueMax) setAutoContinueMax.value = String(prefs.autoContinueMaxRuns ?? 1);
  applyAutoContinuePrefs(prefs);
}

function readAutoContinuePrefs() {
  return {
    autoContinueEnabled: !!setAutoContinue?.checked,
    autoContinueDelaySec: Number(setAutoContinueDelay?.value) || 30,
    autoContinueMaxRuns: Number(setAutoContinueMax?.value) || 1,
  };
}

function readSettingsForm() {
  commitAgentEditor();
  return {
    working_directory: setWorkingDirectory?.value?.trim() || '',
    writable_roots: String(setWritableRoots?.value || '').split(/\r?\n/).map((v) => v.trim()).filter(Boolean),
    workspace_network_access: !!setWorkspaceNetwork?.checked,
    max_threads: Number(setMaxThreads?.value) || 6,
    max_depth: Number.isFinite(Number(setMaxDepth?.value)) ? Number(setMaxDepth.value) : 1,
    interrupt_message: !!setInterruptMessage?.checked,
    resource_preset: setResourcePreset?.value || 'balanced',
    rollout_budget_enabled: !!setRolloutBudget?.checked,
    rollout_limit_tokens: Number(setRolloutLimit?.value) || 100000,
    rollout_reminder_tokens: Number(setRolloutReminder?.value) || 10000,
    model_auto_compact_token_limit: Number(setCompactLimit?.value) || 0,
    tool_output_token_limit: Number(setToolOutputLimit?.value) || 0,
    ram_warning_mb: Number(setRamWarning?.value) || 2048,
    agent_roles: agentRoles,
    plan_mode_reasoning_effort: setPlanReasoning?.value || '',
    model_reasoning_summary: setReasoningSummary?.value || '',
    model_verbosity: setVerbosity?.value || '',
    hooks_enabled: !!setHooksEnabled?.checked,
    prevent_idle_sleep: !!setPreventSleep?.checked,
    model: setModel?.value?.trim() || '',
    model_reasoning_effort: setReasoning?.value || '',
    personality: setPersonality?.value || '',
    web_search: setWebSearch?.value || '',
    sandbox_mode: setSandbox?.value || 'workspace-write',
    approval_policy: setApproval?.value || 'on-request',
    startup_timeout_sec: Number(setStartup?.value) || 30,
    tool_timeout_sec: Number(setTool?.value) || 60,
    job_max_runtime_seconds: Number(setJob?.value) || 1800,
    network_proxy: !!setProxy?.checked,
  };
}

function fillSettingsForm(s = {}) {
  if (setWorkingDirectory) {
    setWorkingDirectory.value = s.working_directory || '';
    setWorkingDirectory.placeholder = t('settings.workingDirectory.auto');
  }
  if (setWritableRoots) {
    setWritableRoots.value = Array.isArray(s.writable_roots) ? s.writable_roots.join('\n') : '';
    setWritableRoots.placeholder = t('settings.writableRoots.placeholder');
  }
  if (setWorkspaceNetwork) setWorkspaceNetwork.checked = !!s.workspace_network_access;
  if (setMaxThreads) setMaxThreads.value = String(s.max_threads ?? 6);
  if (setMaxDepth) setMaxDepth.value = String(s.max_depth ?? 1);
  if (setInterruptMessage) setInterruptMessage.checked = s.interrupt_message !== false;
  if (setResourcePreset) setResourcePreset.value = s.resource_preset || 'balanced';
  if (setRolloutBudget) setRolloutBudget.checked = !!s.rollout_budget_enabled;
  if (setRolloutLimit) setRolloutLimit.value = String(s.rollout_limit_tokens ?? 100000);
  if (setRolloutReminder) setRolloutReminder.value = String(s.rollout_reminder_tokens ?? 10000);
  if (setCompactLimit) setCompactLimit.value = String(s.model_auto_compact_token_limit ?? 0);
  if (setToolOutputLimit) setToolOutputLimit.value = String(s.tool_output_token_limit ?? 0);
  if (setRamWarning) setRamWarning.value = String(s.ram_warning_mb ?? 2048);
  agentRoles = Array.isArray(s.agent_roles) ? s.agent_roles.map((role) => ({ ...role })) : [];
  renderAgentRoleList();
  if (setPlanReasoning) setPlanReasoning.value = s.plan_mode_reasoning_effort || '';
  if (setReasoningSummary) setReasoningSummary.value = s.model_reasoning_summary || '';
  if (setVerbosity) setVerbosity.value = s.model_verbosity || '';
  if (setHooksEnabled) setHooksEnabled.checked = !!s.hooks_enabled;
  if (setPreventSleep) setPreventSleep.checked = !!s.prevent_idle_sleep;
  if (setModel) {
    setModel.value = s.model || '';
    setModel.placeholder = t('settings.model.placeholder');
  }
  if (setReasoning) setReasoning.value = s.model_reasoning_effort || '';
  if (setPersonality) setPersonality.value = s.personality || '';
  if (setWebSearch) setWebSearch.value = s.web_search || '';
  if (setSandbox) setSandbox.value = s.sandbox_mode || 'workspace-write';
  if (setApproval) setApproval.value = s.approval_policy || 'on-request';
  if (setStartup) setStartup.value = String(s.startup_timeout_sec ?? 30);
  if (setTool) setTool.value = String(s.tool_timeout_sec ?? 60);
  if (setJob) setJob.value = String(s.job_max_runtime_seconds ?? 1800);
  if (setProxy) setProxy.checked = !!s.network_proxy;
}

function selectedAgentRole() {
  return agentRoles.find((role) => role.id === setAgentRole?.value) || null;
}

function commitAgentEditor() {
  const role = selectedAgentRole();
  if (!role) return;
  role.enabled = !!setAgentEnabled?.checked;
  role.name = String(setAgentName?.value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 48);
  role.description = String(setAgentDescription?.value || '').trim();
  role.developer_instructions = String(setAgentInstructions?.value || '').trim();
  role.model = String(setAgentModel?.value || '').trim();
  role.model_reasoning_effort = setAgentReasoning?.value || '';
}

function renderAgentEditor() {
  const role = selectedAgentRole();
  if (setAgentEditor) setAgentEditor.hidden = !role;
  if (!role) return;
  if (setAgentEnabled) setAgentEnabled.checked = role.enabled !== false;
  if (setAgentName) setAgentName.value = role.name || '';
  if (setAgentDescription) setAgentDescription.value = role.description || '';
  if (setAgentInstructions) setAgentInstructions.value = role.developer_instructions || '';
  if (setAgentModel) setAgentModel.value = role.model || '';
  if (setAgentReasoning) setAgentReasoning.value = role.model_reasoning_effort || '';
}

function renderAgentRoleList(selectedId) {
  if (!setAgentRole) return;
  const keep = selectedId || setAgentRole.value || agentRoles[0]?.id || '';
  setAgentRole.replaceChildren();
  if (!agentRoles.length) {
    const option = document.createElement('option');
    option.value = ''; option.textContent = t('settings.agentNone');
    setAgentRole.append(option);
  } else {
    for (const role of agentRoles) {
      const option = document.createElement('option');
      option.value = role.id;
      option.textContent = role.name || role.id;
      setAgentRole.append(option);
    }
    setAgentRole.value = agentRoles.some((role) => role.id === keep) ? keep : agentRoles[0].id;
  }
  renderAgentEditor();
}

const RESOURCE_PRESET_VALUES = {
  saver: { reasoning: 'low', threads: 2, depth: 1, runtime: 900, compact: 48000, tool: 6000, budget: true, limit: 80000, reminder: 8000, ram: 1024 },
  balanced: { reasoning: 'medium', threads: 6, depth: 1, runtime: 1800, compact: 64000, tool: 12000, budget: false, limit: 100000, reminder: 10000, ram: 2048 },
  performance: { reasoning: 'high', threads: 12, depth: 2, runtime: 3600, compact: 0, tool: 0, budget: false, limit: 200000, reminder: 20000, ram: 4096 },
};

function applyResourcePreset(name) {
  const p = RESOURCE_PRESET_VALUES[name];
  if (!p) return;
  if (setReasoning) setReasoning.value = p.reasoning;
  if (setMaxThreads) setMaxThreads.value = String(p.threads);
  if (setMaxDepth) setMaxDepth.value = String(p.depth);
  if (setJob) setJob.value = String(p.runtime);
  if (setCompactLimit) setCompactLimit.value = String(p.compact);
  if (setToolOutputLimit) setToolOutputLimit.value = String(p.tool);
  if (setRolloutBudget) setRolloutBudget.checked = p.budget;
  if (setRolloutLimit) setRolloutLimit.value = String(p.limit);
  if (setRolloutReminder) setRolloutReminder.value = String(p.reminder);
  if (setRamWarning) setRamWarning.value = String(p.ram);
}

async function refreshRamUsage() {
  if (!setRamStatus || settingsPanel?.hidden) return;
  const usage = await api?.getResourceUsage?.();
  if (!usage?.ok) return;
  const limit = Math.max(256, Number(setRamWarning?.value) || 2048);
  const over = usage.ramMb >= limit;
  setRamStatus.textContent = t(over ? 'settings.ramOver' : 'settings.ramUsage', {
    used: usage.ramMb,
    limit,
    n: usage.processCount,
  });
  setStatusTone(setRamStatus, over ? 'bad' : 'ok');
}

function setStatusTone(el, tone) {
  if (!el) return;
  el.classList.remove('is-ok', 'is-warn', 'is-bad', 'is-muted');
  if (tone) el.classList.add(`is-${tone}`);
}

function renderLicenseStatus(status) {
  if (!setLicenseStatusEl) return;
  if (!status) {
    setLicenseStatusEl.textContent = t('settings.license.unknown');
    setStatusTone(setLicenseStatusEl, 'muted');
    return;
  }
  if (status.licensed) {
    setLicenseStatusEl.textContent = t('settings.license.licensed');
    setStatusTone(setLicenseStatusEl, 'ok');
  } else if (status.locked || status.expired) {
    setLicenseStatusEl.textContent = t('settings.license.expired');
    setStatusTone(setLicenseStatusEl, 'bad');
  } else {
    setLicenseStatusEl.textContent = t('settings.license.trial', {
      n: Math.max(0, Number(status.daysLeft) || 0),
    });
    // Trial active but no license key yet
    setStatusTone(setLicenseStatusEl, 'warn');
  }
  if (settingsLicenseBuyBtn) {
    settingsLicenseBuyBtn.disabled = !status.sponsorUrl;
  }
}

async function refreshAccountStatus() {
  if (setCodexStatusEl) {
    setCodexStatusEl.textContent = t('settings.codexLogin.unknown');
    setStatusTone(setCodexStatusEl, 'muted');
  }
  if (setLicenseStatusEl) {
    setLicenseStatusEl.textContent = t('settings.license.unknown');
    setStatusTone(setLicenseStatusEl, 'muted');
  }

  try {
    const login = await api?.loginStatus?.();
    if (!setCodexStatusEl) {
      /* skip */
    } else if (!login?.hasCodex) {
      setCodexStatusEl.textContent = t('settings.codexLogin.missing');
      setStatusTone(setCodexStatusEl, 'bad');
    } else if (login.loggedIn) {
      setCodexStatusEl.textContent = t('settings.codexLogin.ok');
      setStatusTone(setCodexStatusEl, 'ok');
    } else {
      setCodexStatusEl.textContent = t('settings.codexLogin.no');
      setStatusTone(setCodexStatusEl, 'bad');
    }
  } catch {
    if (setCodexStatusEl) {
      setCodexStatusEl.textContent = t('settings.codexLogin.no');
      setStatusTone(setCodexStatusEl, 'bad');
    }
  }

  try {
    const trial = await api?.getTrialStatus?.();
    renderLicenseStatus(trial);
  } catch {
    renderLicenseStatus(null);
  }
}

async function activateLicenseFromInput(inputEl, buttonEl) {
  const key = inputEl?.value || '';
  if (buttonEl) buttonEl.disabled = true;
  try {
    const r = await api?.activateLicense?.(key);
    if (!r?.ok) {
      flashAction(r?.errorKey ? t(r.errorKey) : (r?.error || t('trial.activate.fail')));
      return false;
    }
    applyTrialLock(r.trial || { locked: false, expired: false, licensed: true });
    if (inputEl) inputEl.value = '';
    renderLicenseStatus(r.trial || { licensed: true, locked: false });
    flashAction(t('trial.activate.ok'));
    api?.getState?.().then(applyBridgeState);
    return true;
  } finally {
    if (buttonEl) buttonEl.disabled = false;
  }
}

async function openSettings() {
  if (padBlocks()) return;
  closeIconPicker();
  closeGuide();
  closeKeymap();
  if (!settingsPanel) return;
  if (settingsSearch) settingsSearch.placeholder = t('settings.search');
  try {
    const [r, prefs] = await Promise.all([api?.getCodexSettings?.(), api?.getPadPrefs?.()]);
    fillSettingsForm(r?.settings || {});
    fillAutoContinuePrefs(prefs || {});
    const setLocaleEl = document.getElementById('set-locale');
    if (setLocaleEl) setLocaleEl.value = state.locale;
    if (settingsHint) {
      settingsHint.textContent = r?.meta?.profilePath
        ? t('settings.hint.profile', { profile: r.meta.profile })
        : t('settings.hint');
    }
  } catch {
    fillSettingsForm({});
    fillAutoContinuePrefs({});
  }
  settingsPanel.hidden = false;
  flashAction(t('flash.settings'));
  refreshAccountStatus();
  refreshRamUsage();
  refreshBackups();
}

async function refreshBackups() {
  if (!settingsBackupSelect) return;
  const result = await api?.listCodexBackups?.(); settingsBackupSelect.replaceChildren();
  for (const backup of result?.backups || []) {
    const option = document.createElement('option'); option.value = backup.id;
    option.textContent = new Date(backup.createdAt).toLocaleString(); settingsBackupSelect.append(option);
  }
  settingsBackupSelect.hidden = !settingsBackupSelect.options.length;
  const button = document.getElementById('settings-restore'); if (button) button.disabled = !settingsBackupSelect.options.length;
}

function closeSettings() {
  if (settingsPanel) settingsPanel.hidden = true;
}
settingsSearch?.addEventListener('input', () => {
  const query = settingsSearch.value.trim().toLocaleLowerCase();
  document.querySelectorAll('#settings-body > .settings-section, #settings-body > .settings-field, #settings-body > .settings-row').forEach((section) => {
    section.classList.toggle('settings-filter-hidden', !!query && !section.textContent.toLocaleLowerCase().includes(query));
  });
});

function closeMcp() {
  if (mcpPanel) mcpPanel.hidden = true;
}
function closeSkills() { if (skillsPanel) skillsPanel.hidden = true; }

async function refreshSkills() {
  if (!skillsList) return;
  skillsList.replaceChildren(mcpText('p', 'settings-status is-muted', t('skills.loading')));
  const result = await api?.listSkillsAndPlugins?.();
  skillsList.replaceChildren();
  if (!result?.ok) { skillsList.append(mcpText('p', 'settings-status is-bad', result?.error || t('skills.error'))); return; }
  if (result.pluginError) skillsList.append(mcpText('p', 'settings-status is-bad', `${t('skills.pluginError')} · ${result.pluginError}`));
  const skillTitle = mcpText('p', 'settings-section-title', `${t('skills.installed')} · ${result.skills?.length || 0}`); skillsList.append(skillTitle);
  for (const skill of result.skills || []) {
    const card = document.createElement('div'); card.className = 'mcp-server-card';
    const head = document.createElement('div'); head.className = 'mcp-server-head'; head.append(mcpText('span', 'mcp-server-name', skill.name), mcpText('span', 'mcp-server-meta', skill.source));
    card.append(head, mcpText('p', 'mcp-server-meta', skill.description || skill.path), mcpText('p', 'mcp-server-meta', skill.path)); skillsList.append(card);
  }
  if (result.plugins?.length) {
    skillsList.append(mcpText('p', 'settings-section-title', `${t('skills.plugins')} · ${result.plugins.length}`));
    for (const plugin of result.plugins) skillsList.append(mcpText('p', 'settings-status', plugin.name || plugin.id || JSON.stringify(plugin)));
  }
}

function fillSkillEditor(skill = null) {
  editingSkillOriginal = skill?.folder || '';
  if (skillEditName) skillEditName.value = skill?.name || '';
  if (skillEditDescription) skillEditDescription.value = skill?.description || '';
  if (skillEditInstructions) skillEditInstructions.value = skill?.instructions || '';
  const del = document.getElementById('skill-edit-delete'); if (del) del.disabled = !skill;
}

async function refreshPersonalSkills(preferred = '') {
  const result = await api?.listPersonalSkills?.(); personalSkills = result?.skills || [];
  if (!skillEditSelect) return;
  skillEditSelect.replaceChildren();
  const draft = document.createElement('option'); draft.value = ''; draft.textContent = t('skills.newDraft'); skillEditSelect.append(draft);
  for (const skill of personalSkills) { const option = document.createElement('option'); option.value = skill.folder; option.textContent = skill.name; skillEditSelect.append(option); }
  if (preferred && personalSkills.some((skill) => skill.folder === preferred)) skillEditSelect.value = preferred;
  const selected = personalSkills.find((skill) => skill.folder === skillEditSelect.value) || null; fillSkillEditor(selected);
}

async function refreshSkillsWorkspace(preferred = '') { await Promise.all([refreshSkills(), refreshPersonalSkills(preferred)]); }

async function openSkills() {
  closeMcp(); closeSettings(); closeGuide(); closeKeymap(); closeIconPicker();
  if (!skillsPanel) return; skillsPanel.hidden = false; await refreshSkillsWorkspace();
}

function mcpText(tag, className, value) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = value;
  return el;
}

async function refreshMcpServers() {
  if (!mcpList) return;
  mcpList.replaceChildren(mcpText('p', 'settings-status is-muted', t('mcp.loading')));
  const result = await api?.listMcpServers?.();
  if (!result?.ok) {
    mcpList.replaceChildren(mcpText('p', 'settings-status is-bad', result?.error || t('mcp.error')));
    return;
  }
  mcpList.replaceChildren();
  if (!result.servers?.length) {
    mcpList.append(mcpText('p', 'settings-status is-muted', t('mcp.empty')));
    return;
  }
  for (const server of result.servers) {
    const card = document.createElement('div'); card.className = 'mcp-server-card';
    const head = document.createElement('div'); head.className = 'mcp-server-head';
    head.append(mcpText('span', 'mcp-server-name', server.name));
    const toggleLabel = document.createElement('label'); toggleLabel.className = 'settings-check';
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = server.enabled !== false;
    toggleLabel.append(toggle, mcpText('span', '', toggle.checked ? t('mcp.enabled') : t('mcp.disabled')));
    head.append(toggleLabel); card.append(head);
    const transport = server.transport || {};
    card.append(mcpText('p', 'mcp-server-meta', `${transport.type || 'unknown'} · ${transport.url || transport.command || ''} · ${server.auth_status || 'auth unknown'}`));
    const row = document.createElement('div'); row.className = 'settings-row';
    const makeTimeout = (label, value, min, max) => {
      const field = document.createElement('div'); field.className = 'settings-field';
      field.append(mcpText('label', 'voice-label', label));
      const input = document.createElement('input'); input.className = 'voice-input'; input.type = 'number'; input.min = String(min); input.max = String(max); input.value = String(value);
      field.append(input); return { field, input };
    };
    const startup = makeTimeout(t('settings.startup'), server.startup_timeout_sec ?? 30, 5, 300);
    const tool = makeTimeout(t('settings.tool'), server.tool_timeout_sec ?? 60, 10, 3600);
    row.append(startup.field, tool.field); card.append(row);
    const actions = document.createElement('div'); actions.className = 'voice-actions settings-inline-actions';
    const actionButton = (label, action) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'voice-btn'; button.textContent = label;
      button.addEventListener('click', async () => {
        button.disabled = true;
        const done = await api?.mcpCommand?.(action, { name: server.name });
        button.disabled = false;
        if (done?.canceled) return;
        flashAction(done?.ok ? t(`mcp.${action}Ok`) : done?.error || t('mcp.error'));
        if (done?.ok && action === 'remove') refreshMcpServers();
      });
      return button;
    };
    actions.append(actionButton(t('mcp.check'), 'get'));
    if (transport.type === 'streamable_http') actions.append(actionButton(t('mcp.login'), 'login'), actionButton(t('mcp.logout'), 'logout'));
    actions.append(actionButton(t('mcp.remove'), 'remove'));
    card.append(actions);
    const save = async () => {
      card.style.opacity = '0.55';
      const saved = await api?.setMcpServerOptions?.(server.name, { enabled: toggle.checked, startup_timeout_sec: Number(startup.input.value), tool_timeout_sec: Number(tool.input.value) });
      card.style.opacity = '';
      if (!saved?.ok) flashAction(saved?.error || t('mcp.error'));
      else { toggleLabel.lastChild.textContent = toggle.checked ? t('mcp.enabled') : t('mcp.disabled'); flashAction(t('mcp.saved')); }
    };
    toggle.addEventListener('change', save);
    startup.input.addEventListener('change', save);
    tool.input.addEventListener('change', save);
    mcpList.append(card);
  }
}

async function openMcp() {
  closeSkills(); closeSettings(); closeGuide(); closeKeymap(); closeIconPicker();
  if (!mcpPanel) return;
  mcpPanel.hidden = false;
  await refreshMcpServers();
}

const mcpAddType = document.getElementById('mcp-add-type');
const mcpAddHttpFields = document.getElementById('mcp-add-http-fields');
const mcpAddStdioFields = document.getElementById('mcp-add-stdio-fields');
mcpAddType?.addEventListener('change', () => {
  const http = mcpAddType.value === 'http';
  if (mcpAddHttpFields) mcpAddHttpFields.hidden = !http;
  if (mcpAddStdioFields) mcpAddStdioFields.hidden = http;
});
document.getElementById('mcp-add-submit')?.addEventListener('click', async () => {
  const type = mcpAddType?.value || 'http';
  const payload = {
    type,
    name: document.getElementById('mcp-add-name')?.value?.trim() || '',
    url: document.getElementById('mcp-add-url')?.value?.trim() || '',
    bearer_token_env_var: document.getElementById('mcp-add-token-env')?.value?.trim() || '',
    command: document.getElementById('mcp-add-command')?.value?.trim() || '',
    args: String(document.getElementById('mcp-add-args')?.value || '').split(/\r?\n/).map((v) => v.trim()).filter(Boolean),
  };
  const done = await api?.mcpCommand?.('add', payload);
  flashAction(done?.ok ? t('mcp.addOk') : done?.error || t('mcp.error'));
  if (done?.ok) refreshMcpServers();
});

document.getElementById('btn-help')?.addEventListener('click', openGuide);
document.getElementById('btn-keymap')?.addEventListener('click', openKeymap);
document.getElementById('mod-picker')?.addEventListener('click', async (e) => {
  const btn = e.target?.closest?.('[data-mod]');
  if (!btn) return;
  const mod = normalizeHotkeyMod(btn.getAttribute('data-mod'));
  const r = await api?.setPadPrefs?.({ hotkeyModifier: mod });
  applyHotkeyModifier(r?.hotkeyModifier || mod);
  flashAction(t(`flash.mod.${mod}`));
});
document.getElementById('btn-settings')?.addEventListener('click', openSettings);
document.getElementById('btn-mcp')?.addEventListener('click', openMcp);
document.getElementById('btn-skills')?.addEventListener('click', openSkills);
document.getElementById('skills-close')?.addEventListener('click', closeSkills);
document.getElementById('skills-refresh')?.addEventListener('click', () => refreshSkillsWorkspace(skillEditSelect?.value || ''));
skillEditSelect?.addEventListener('change', () => fillSkillEditor(personalSkills.find((skill) => skill.folder === skillEditSelect.value) || null));
document.getElementById('skill-edit-new')?.addEventListener('click', () => { if (skillEditSelect) skillEditSelect.value = ''; fillSkillEditor(null); skillEditName?.focus(); });
document.getElementById('skill-edit-save')?.addEventListener('click', async () => {
  const input = { originalName: editingSkillOriginal, name: skillEditName?.value || '', description: skillEditDescription?.value || '', instructions: skillEditInstructions?.value || '' };
  const result = await api?.savePersonalSkill?.(input);
  if (!result?.ok) { flashAction(result?.error || t('skills.saveFail')); return; }
  flashAction(t('skills.saveOk')); await refreshSkillsWorkspace(result.skill.folder);
});
document.getElementById('skill-edit-delete')?.addEventListener('click', async () => {
  if (!editingSkillOriginal) return;
  const result = await api?.deletePersonalSkill?.(editingSkillOriginal);
  if (result?.canceled) return;
  if (!result?.ok) { flashAction(result?.error || t('skills.deleteFail')); return; }
  flashAction(t('skills.deleteOk')); await refreshSkillsWorkspace();
});
document.getElementById('mcp-close')?.addEventListener('click', closeMcp);
document.getElementById('mcp-refresh')?.addEventListener('click', refreshMcpServers);
document.getElementById('mcp-open-config')?.addEventListener('click', () => api?.openCodexConfig?.());
document.getElementById('btn-settings')?.addEventListener('click', closeMcp);
document.getElementById('btn-help')?.addEventListener('click', closeMcp);
document.getElementById('btn-keymap')?.addEventListener('click', closeMcp);
document.getElementById('btn-settings')?.addEventListener('click', closeSkills);
document.getElementById('btn-help')?.addEventListener('click', closeSkills);
document.getElementById('btn-keymap')?.addEventListener('click', closeSkills);
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
mcpPanel?.addEventListener('click', (e) => {
  if (e.target === mcpPanel) closeMcp();
});
skillsPanel?.addEventListener('click', (e) => { if (e.target === skillsPanel) closeSkills(); });
document.getElementById('settings-save')?.addEventListener('click', async () => {
  const r = await api?.saveCodexSettings?.(readSettingsForm());
  if (r?.ok) {
    const prefs = await api?.setPadPrefs?.(readAutoContinuePrefs());
    fillAutoContinuePrefs(prefs || readAutoContinuePrefs());
    fillSettingsForm(r.settings);
    flashAction(t('flash.settingsSaved'));
    if (settingsHint) {
      settingsHint.textContent = r.warning
        ? t('flash.savedWarn', { warn: r.warning })
        : t('flash.savedApply', { path: r.profile || 'agent-micro' });
    }
    refreshBackups();
  } else if (!r?.canceled) {
    flashAction(t('flash.settingsFail'));
  }
});
document.getElementById('settings-restore')?.addEventListener('click', async () => {
  const id = settingsBackupSelect?.value; if (!id) return;
  const result = await api?.restoreCodexBackup?.(id);
  if (result?.ok) { fillSettingsForm(result.settings || {}); flashAction(t('settings.restoreOk')); refreshBackups(); }
  else if (!result?.canceled) flashAction(result?.error || t('settings.restoreFail'));
});
document.getElementById('settings-choose-directory')?.addEventListener('click', async () => {
  const r = await api?.chooseCodexWorkingDirectory?.();
  if (r?.ok && setWorkingDirectory) setWorkingDirectory.value = r.path || '';
});
document.getElementById('settings-clear-directory')?.addEventListener('click', () => {
  if (setWorkingDirectory) setWorkingDirectory.value = '';
});
setResourcePreset?.addEventListener('change', () => applyResourcePreset(setResourcePreset.value));
setAgentRole?.addEventListener('change', renderAgentEditor);
[
  setAgentEnabled, setAgentName, setAgentDescription, setAgentInstructions, setAgentModel, setAgentReasoning,
].forEach((el) => el?.addEventListener('input', () => {
  commitAgentEditor();
  if (el === setAgentName) {
    const option = [...(setAgentRole?.options || [])].find((item) => item.value === setAgentRole.value);
    if (option) option.textContent = setAgentName.value || option.value;
  }
}));
document.getElementById('settings-agent-add')?.addEventListener('click', () => {
  commitAgentEditor();
  const id = `role-${Date.now().toString(36)}`;
  agentRoles.push({ id, name: `agent-${agentRoles.length + 1}`, description: '', developer_instructions: '', model: '', model_reasoning_effort: '', enabled: true });
  renderAgentRoleList(id);
});
document.getElementById('settings-agent-delete')?.addEventListener('click', () => {
  const id = setAgentRole?.value;
  if (!id) return;
  agentRoles = agentRoles.filter((role) => role.id !== id);
  renderAgentRoleList();
});
setRamWarning?.addEventListener('input', refreshRamUsage);
[
  setReasoning, setMaxThreads, setMaxDepth, setJob, setRolloutBudget,
  setRolloutLimit, setRolloutReminder, setCompactLimit, setToolOutputLimit, setRamWarning,
].forEach((el) => el?.addEventListener('input', () => {
  if (setResourcePreset) setResourcePreset.value = 'custom';
}));
setInterval(refreshRamUsage, 3000);
document.getElementById('settings-add-writable-root')?.addEventListener('click', async () => {
  const r = await api?.chooseCodexWorkingDirectory?.();
  if (!r?.ok || !r.path || !setWritableRoots) return;
  const roots = String(setWritableRoots.value || '').split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  if (!roots.includes(r.path)) roots.push(r.path);
  setWritableRoots.value = roots.join('\n');
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
hud.modelChange?.addEventListener('click', toggleQuickDeepModel);
hud.continueButton?.addEventListener('click', sendManualContinue);
setInterval(refreshDevServerStatus, 3000);
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
  const folder = current.projectRoot || current.cwd || '—';
  const projectName = current.projectName || (folder === '—' ? '—' : folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop()) || folder;
  hud.folder.textContent = projectName;
  hud.folder.title = folder === '—' ? '' : folder;
  const gitRepoName = document.getElementById('git-repo-name');
  if (gitRepoName) { gitRepoName.textContent = projectName; gitRepoName.title = folder === '—' ? '' : folder; }
  hud.status.textContent = statusLabel(current.status || 'off');
  hud.reason.textContent = REASONING[state.reasoningIndex];
  const agentBusy = current.status === 'thinking' || current.status === 'working';
  const modelMode = state.agentModelModes[state.selected] || 'deep';
  if (hud.model) {
    hud.model.textContent = modelMode === 'light' ? t('hud.modelLight') : t('hud.modelDeep');
    hud.model.title = modelMode === 'light' ? QUICK_MODEL : DEEP_MODEL;
  }
  if (hud.modelChange) {
    hud.modelChange.disabled = agentBusy || !state.connected;
    hud.modelChange.textContent = modelMode === 'light' ? t('hud.toDeep') : t('hud.toLight');
    hud.modelChange.title = modelMode === 'light' ? DEEP_MODEL : QUICK_MODEL;
  }
  if (hud.continueStatus) hud.continueStatus.textContent = state.autoContinueEnabled
    ? t('hud.continueAuto', { sec: state.autoContinueDelaySec, max: state.autoContinueMaxRuns })
    : t('hud.continueManual');
  if (hud.continueButton) hud.continueButton.disabled = agentBusy || !state.connected;
  const layerName = layerDisplayName(state.layer);
  hud.link.textContent = state.connected
    ? `Codex CLI · ${state.mode} · ${layerName}`
    : state.mode === 'offline'
      ? `demo · CLI · ${layerName}`
      : `Codex CLI · ${state.mode} · ${layerName}`;
  linkDot.classList.toggle('on', state.connected);
  linkDot.classList.toggle('demo', !state.connected);
  pad3d.setCmdActive('fast', state.fastMode);
  pad3d.setCmdActive('send', state.devServerRunning, 0x167a45, 0.32);
  const forkOk =
    typeof state.canFork === 'boolean' ? state.canFork : canForkFromAgents(state.agents);
  pad3d.setCmdEnabled?.('fork', forkOk);
}

async function refreshDevServerStatus() {
  const result = await api?.getDevServerStatus?.();
  state.devServerRunning = !!result?.running;
  state.devServerCwd = result?.cwd || '';
  state.devServerCommand = result?.command || '';
  state.devServerKind = result?.kind || '';
  render();
}

async function toggleQuickDeepModel() {
  const current = state.agentModelModes[state.selected] || 'deep';
  const next = current === 'light' ? 'deep' : 'light';
  const model = next === 'light' ? QUICK_MODEL : DEEP_MODEL;
  if (hud.modelChange) hud.modelChange.disabled = true;
  const result = await api?.switchActiveModel?.(model);
  if (!result?.ok) flashAction(result?.busy ? t('flash.modelBusy') : result?.error || t('flash.modelFail'));
  else {
    state.agentModelModes[state.selected] = next;
    flashAction(next === 'light' ? t('flash.modelLight') : t('flash.modelDeep'));
  }
  render();
}

async function toggleCurrentDevServer() {
  const result = await api?.toggleDevServer?.();
  if (!result?.ok) flashAction(result?.error || t('flash.devFail'));
  else {
    state.devServerRunning = !!result.running;
    state.devServerCwd = result.cwd || '';
    state.devServerCommand = result.command || '';
    state.devServerKind = result.kind || state.devServerKind || '';
    flashAction(result.running
      ? `${t('flash.devStarted')} · ${result.kind || result.command || ''}`
      : t('flash.devStopped'));
  }
  render();
}

function cancelAutoContinue(index) {
  const timer = state.autoContinueTimers[index];
  if (timer) clearTimeout(timer);
  state.autoContinueTimers[index] = null;
}

function cancelAllAutoContinue() {
  state.autoContinueTimers.forEach((_timer, index) => cancelAutoContinue(index));
}

async function sendManualContinue() {
  const index = state.selected;
  cancelAutoContinue(index);
  state.autoContinueCounts[index] = 0;
  state.autoContinueIssued[index] = false;
  const result = await api?.send?.('Continue.');
  flashAction(result?.ok ? t('flash.continue') : result?.error || t('flash.continueFail'));
}

function scheduleAutoContinue(index) {
  cancelAutoContinue(index);
  if (!state.autoContinueEnabled || index !== state.selected || state.autoContinueCounts[index] >= state.autoContinueMaxRuns) return;
  state.autoContinueTimers[index] = setTimeout(async () => {
    state.autoContinueTimers[index] = null;
    const agent = state.agents[index];
    if (!state.autoContinueEnabled || index !== state.selected || !['idle', 'complete'].includes(agent?.status)) return;
    state.autoContinueCounts[index] += 1;
    state.autoContinueIssued[index] = true;
    const result = await api?.send?.('Continue.');
    flashAction(result?.ok
      ? t('flash.autoContinue', { count: state.autoContinueCounts[index], max: state.autoContinueMaxRuns })
      : result?.error || t('flash.continueFail'));
  }, state.autoContinueDelaySec * 1000);
}

function applyAutoContinuePrefs(prefs = {}) {
  state.autoContinueEnabled = prefs.autoContinueEnabled === true;
  state.autoContinueDelaySec = Math.max(5, Math.min(3600, Number(prefs.autoContinueDelaySec) || 30));
  state.autoContinueMaxRuns = Math.max(1, Math.min(10, Number(prefs.autoContinueMaxRuns) || 1));
  if (!state.autoContinueEnabled) cancelAllAutoContinue();
  render();
}

function canForkFromAgents(agents) {
  const list = Array.isArray(agents) ? agents : [];
  // UI: only disable at 6/6 — keep the key looking live otherwise
  return list.some((a) => !a || a.status === 'off') || list.length < 6;
}

function applyBridgeState(s) {
  if (!s) return;
  const previousAgents = state.agents.map((agent) => ({ ...agent }));
  state.connected = !!s.connected;
  state.mode = s.mode || 'offline';
  state.linkMode = 'cli';
  state.provider = 'codex';
  const previousSelected = state.selected;
  state.selected = s.selected ?? state.selected;
  state.reasoningIndex = s.reasoningIndex ?? state.reasoningIndex;
  state.fastMode = !!s.fastMode;
  state.planMode = !!s.planMode;
  if (typeof s.canFork === 'boolean') state.canFork = s.canFork;
  else if (Array.isArray(s.agents)) {
    state.canFork = canForkFromAgents(s.agents);
  }
  if (Array.isArray(s.agents)) {
    state.agents = s.agents;
    state.agents.forEach((agent, index) => {
      const before = previousAgents[index]?.status;
      const after = agent?.status;
      const beforeBusy = before === 'thinking' || before === 'working';
      const afterBusy = after === 'thinking' || after === 'working';
      const afterSettled = after === 'idle' || after === 'complete';
      if (!afterSettled) cancelAutoContinue(index);
      if ((before === 'idle' || before === 'complete') && afterBusy) {
        if (state.autoContinueIssued[index]) state.autoContinueIssued[index] = false;
        else state.autoContinueCounts[index] = 0;
      }
      if (beforeBusy && afterSettled) scheduleAutoContinue(index);
    });
  }
  if (s.action) flashAction(s.action);
  render();
  if (previousSelected !== state.selected) { cancelAllAutoContinue(); refreshDevServerStatus(); }
}

async function onAgent(index) {
  if (padBlocks()) return;
  const now = Date.now();
  const dbl = state.lastAgentTap.index === index && now - state.lastAgentTap.at < 350;
  state.lastAgentTap = { index, at: now };
  await api?.select(index, dbl);
  if (dbl) pad3d?.resetJoy?.();
}

/** Mic PTT: hold = talk · double-tap = hands-free latch */
function onMicPress() {
  if (padBlocks()) return;
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
  if (padBlocks()) return;
  // Start still in flight (common on short holds) — request stop when ready
  if (micStarting && !pendingMicLatch) {
    micCancelStart = true;
    return;
  }
  if (state.recording && !micLatched) stopRecording({ process: true });
}

async function onCmd(cmd) {
  if (padBlocks()) return;
  if (cmd === 'mic') {
    // fallback if press/release not wired
    onMicPress();
    return;
  }

  if (cmd === 'send') {
    await toggleCurrentDevServer();
    return;
  }

  // Icons are display-only — cmd binding never changes
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
  if (padBlocks()) return;
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
  if (padBlocks()) return;
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
      if (padBlocks()) return;
      state.layer = (state.layer + 1) % LAYERS.length;
      pad3d?.setLayer?.(state.layer);
      flashAction(t('flash.layer', { name: layerDisplayName(state.layer) }));
      render();
    },
  });
  applyKeyIcons();
  render();
  refreshDevServerStatus();
  flashAction(t('flash.padReady'));
} catch (err) {
  console.error(err);
  canvasHost.innerHTML = `<div style="padding:16px;font:12px/1.4 system-ui;color:#b00020;white-space:pre-wrap">3D pad failed:\n${err?.stack || err}</div>`;
  flashAction(t('flash.padError'));
}

async function connectAgent({ forceLogin = false } = {}) {
  if (trialBlocks()) {
    flashAction(t('trial.flash'));
    return { ok: false, reason: 'trial' };
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
      flashAction(t('flash.connected'));
      hideLoginGate();
    } else {
      flashAction(t('flash.demo'));
    }
    return result && typeof result === 'object' ? result : { ok: !!result };
  } catch (err) {
    flashAction(err?.message || t('flash.connectFail'));
    return { ok: false, error: err?.message };
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
/** Mod+QWERDF / Tab / arrows / 1–6 — pad or our CLI context */
api?.onHotkey?.(({ cmd, phase, dir, index } = {}) => {
  if (padBlocks()) return;
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
  applyAutoContinuePrefs(prefs || {});
});

api?.getPadPrefs?.().then((prefs) => {
  if (prefs?.locale) applyLocale(prefs.locale);
  else applyStaticI18n();
  if (prefs?.hotkeyModifier) applyHotkeyModifier(prefs.hotkeyModifier);
  applyAutoContinuePrefs(prefs || {});
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
trialActivateBtn?.addEventListener('click', () => {
  activateLicenseFromInput(trialKeyInput, trialActivateBtn);
});
trialKeyInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') trialActivateBtn?.click();
});

settingsCodexLoginBtn?.addEventListener('click', async () => {
  if (trialBlocks()) return;
  settingsCodexLoginBtn.disabled = true;
  flashAction(t('flash.login'));
  try {
    await connectAgent({ forceLogin: true });
    await refreshAccountStatus();
  } finally {
    settingsCodexLoginBtn.disabled = false;
  }
});

loginGateBtn?.addEventListener('click', async () => {
  if (trialBlocks()) return;
  loginGateBtn.disabled = true;
  try {
    const r = await connectAgent({ forceLogin: true });
    if (r?.ok) {
      hideLoginGate();
      await refreshAccountStatus();
    } else if (r?.reason === 'missing') {
      showLoginGate({ missing: true });
    } else {
      showLoginGate();
    }
  } finally {
    loginGateBtn.disabled = false;
  }
});
settingsLicenseActivateBtn?.addEventListener('click', () => {
  activateLicenseFromInput(settingsLicenseKeyEl, settingsLicenseActivateBtn);
});
settingsLicenseKeyEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') settingsLicenseActivateBtn?.click();
});
settingsLicenseBuyBtn?.addEventListener('click', async () => {
  const r = await api?.openSponsor?.();
  if (!r?.ok) flashAction(r?.error || t('trial.buy.none'));
  else flashAction(t('trial.buy.opened'));
});

api?.getTrialStatus?.().then(async (status) => {
  applyTrialLock(status);
  state.provider = 'codex';
  state.linkMode = 'cli';
  if (status?.locked ?? status?.expired) return;
  api?.getState?.().then(applyBridgeState);
  await ensureCodexLoginOnEntry();
}).catch(async () => {
  state.provider = 'codex';
  state.linkMode = 'cli';
  api?.getState?.().then(applyBridgeState);
  await ensureCodexLoginOnEntry();
});

state.provider = 'codex';
state.linkMode = 'cli';

/** While typing in inputs, allow bare keys — Mod chords still win (main before-input). */
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
