/**
 * Agent Micro pad preferences (hotkey modifier, locale, etc.)
 */
const fs = require('fs');
const path = require('path');
const { normalizeLocale } = require('./i18n');

/** @typedef {'command' | 'option' | 'control' | 'capslock'} HotkeyModifier */

const MODIFIERS = ['command', 'option', 'control', 'capslock'];

const DEFAULTS = {
  /** @type {HotkeyModifier} */
  hotkeyModifier: 'command',
  /** @type {'en' | 'ko'} */
  locale: 'en',
  autoContinueEnabled: false,
  autoContinueDelaySec: 30,
  autoContinueMaxRuns: 1,
};

let userDataDir = null;
let cache = null;

function setUserDataPath(dir) {
  userDataDir = dir;
  cache = null;
}

function prefsPath() {
  return path.join(userDataDir || require('os').tmpdir(), 'pad-prefs.json');
}

function normalizeModifier(raw) {
  const mod = String(raw || '').toLowerCase();
  if (mod === 'command' || mod === 'cmd' || mod === 'meta') return 'command';
  if (mod === 'option' || mod === 'alt' || mod === 'opt') return 'option';
  if (mod === 'control' || mod === 'ctrl' || mod === 'controlkey') return 'control';
  if (mod === 'capslock' || mod === 'caps' || mod === 'caps-lock') return 'capslock';
  // Legacy Shift → Command (new default)
  if (mod === 'shift') return 'command';
  return DEFAULTS.hotkeyModifier;
}

function normalize(raw) {
  const clampInt = (value, min, max, fallback) => {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };
  return {
    hotkeyModifier: normalizeModifier(raw?.hotkeyModifier),
    locale: normalizeLocale(raw?.locale ?? DEFAULTS.locale),
    autoContinueEnabled: raw?.autoContinueEnabled === true,
    autoContinueDelaySec: clampInt(raw?.autoContinueDelaySec, 5, 3600, DEFAULTS.autoContinueDelaySec),
    autoContinueMaxRuns: clampInt(raw?.autoContinueMaxRuns, 1, 10, DEFAULTS.autoContinueMaxRuns),
  };
}

function load() {
  if (cache) return { ...cache };
  try {
    if (userDataDir && fs.existsSync(prefsPath())) {
      cache = normalize(JSON.parse(fs.readFileSync(prefsPath(), 'utf8')));
      return { ...cache };
    }
  } catch {
    /* ignore */
  }
  cache = { ...DEFAULTS };
  return { ...cache };
}

function save(partial = {}) {
  const next = normalize({ ...load(), ...partial });
  cache = next;
  try {
    if (userDataDir) {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(prefsPath(), JSON.stringify(next, null, 2), 'utf8');
    }
  } catch {
    /* ignore */
  }
  return { ...next };
}

function getHotkeyModifier() {
  return load().hotkeyModifier;
}

function setHotkeyModifier(mod) {
  return save({ hotkeyModifier: mod });
}

function getLocale() {
  return load().locale;
}

function setLocale(locale) {
  return save({ locale });
}

function modifierGlyph(mod = getHotkeyModifier()) {
  switch (normalizeModifier(mod)) {
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

/**
 * Electron globalShortcut accelerator prefix.
 * Caps Lock is not a supported accelerator mod — returns '' (bare key).
 */
function acceleratorPrefix(mod = getHotkeyModifier()) {
  switch (normalizeModifier(mod)) {
    case 'option':
      return 'Option';
    case 'control':
      return 'Control';
    case 'capslock':
      return '';
    case 'command':
    default:
      return 'Command';
  }
}

function isValidModifier(mod) {
  return MODIFIERS.includes(normalizeModifier(mod));
}

module.exports = {
  setUserDataPath,
  load,
  save,
  getHotkeyModifier,
  setHotkeyModifier,
  getLocale,
  setLocale,
  modifierGlyph,
  acceleratorPrefix,
  normalizeModifier,
  isValidModifier,
  MODIFIERS,
  DEFAULTS,
};
