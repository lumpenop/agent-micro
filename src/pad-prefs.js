/**
 * Agent Micro pad preferences (hotkey modifier, locale, etc.)
 */
const fs = require('fs');
const path = require('path');
const { normalizeLocale } = require('./i18n');

const DEFAULTS = {
  /** @type {'shift' | 'command'} */
  hotkeyModifier: 'shift',
  /** @type {'en' | 'ko'} */
  locale: 'en',
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

function normalize(raw) {
  const mod = String(raw?.hotkeyModifier || '').toLowerCase();
  return {
    hotkeyModifier: mod === 'command' || mod === 'cmd' || mod === 'meta' ? 'command' : 'shift',
    locale: normalizeLocale(raw?.locale ?? DEFAULTS.locale),
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
  return mod === 'command' ? '⌘' : '⇧';
}

function acceleratorPrefix(mod = getHotkeyModifier()) {
  return mod === 'command' ? 'Command' : 'Shift';
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
  DEFAULTS,
};
