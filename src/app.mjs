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
const api = window.codexDesktop;
const STORAGE_KEY = 'agent-micro-key-icons-v1';
const CUSTOM_ICONS_KEY = 'agent-micro-custom-icons-v1';
const MAX_CUSTOM_ICONS = 32;

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
  if (stored.send === 'codex') stored.send = 'send';
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
  lastSendTap: 0,
  lastJoy: { dir: null, at: 0 },
  agents: Array.from({ length: 6 }, () => ({ name: '—', status: 'off' })),
  keyIcons: loadKeyIcons(),
  pickingCmd: null,
  /** @type {'shift' | 'command'} */
  hotkeyModifier: 'shift',
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

/** Mic = macOS dictation into the selected Agent CLI pane (no Whisper). */
async function startRecording({ latched = false } = {}) {
  if (dictationActive) return;
  if (padBlocks()) return;
  flashAction(t('flash.codexJump'));
  const r = await api?.beginVoiceDictation?.();
  if (!r?.ok) {
    if (r?.code === 'AUTH') {
      flashAction(r.stale ? t('flash.authStale') : t('flash.needLogin'));
      // Stale ChatGPT token — force browser re-login then unlock
      await connectAgent({ forceLogin: true });
      return;
    }
    flashAction(r?.error || t('flash.codexApp'));
    return;
  }
  dictationActive = true;
  state.recording = true;
  micLatched = latched;
  padEl.classList.add('recording');
  pad3d?.setRecording(true);
  flashAction(latched ? t('flash.speakTap') : t('flash.speakHold'));
}

async function stopRecording({ process = true } = {}) {
  if (!dictationActive && !state.recording) return;
  dictationActive = false;
  state.recording = false;
  micLatched = false;
  padEl.classList.remove('recording');
  pad3d?.setRecording(false);
  pad3d?.releasePress?.('mic');
  if (!process) {
    flashAction(t('flash.dictationCancel'));
    await api?.endVoiceDictation?.();
    return;
  }
  flashAction(t('flash.codexSending'));
  await api?.endVoiceDictation?.();
  flashAction(t('flash.codexSent'));
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

function showIconGrid() {
  if (pickerGrid) pickerGrid.hidden = false;
  if (iconAddForm) iconAddForm.hidden = true;
  pendingCustomIcon = null;
  if (iconAddPreview) iconAddPreview.removeAttribute('src');
  if (iconAddName) iconAddName.value = '';
}

function showIconAddForm(entry) {
  pendingCustomIcon = entry;
  if (pickerGrid) pickerGrid.hidden = true;
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
      icons: ['send'],
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
const setSandbox = document.getElementById('set-sandbox');
const setApproval = document.getElementById('set-approval');
const setStartup = document.getElementById('set-startup');
const setTool = document.getElementById('set-tool');
const setJob = document.getElementById('set-job');
const setProxy = document.getElementById('set-proxy');
const settingsHint = document.getElementById('settings-hint');
const setCodexStatusEl = document.getElementById('set-codex-status');
const setLicenseStatusEl = document.getElementById('set-license-status');
const settingsLicenseKeyEl = document.getElementById('settings-license-key');
const settingsCodexLoginBtn = document.getElementById('settings-codex-login');
const settingsLicenseActivateBtn = document.getElementById('settings-license-activate');
const settingsLicenseBuyBtn = document.getElementById('settings-license-buy');

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
  refreshAccountStatus();
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
  if (padBlocks()) return;
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
