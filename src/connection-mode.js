/**
 * Codex link mode: desktop shortcuts vs CLI app-server.
 * Greenfield choice — not the old multi-agent provider picker.
 */
const fs = require('fs');
const path = require('path');

const MODES = [
  {
    id: 'desktop',
    label: 'Desktop',
    blurb: 'Codex 앱 단축키 · 붙여넣기 (조이스틱과 동일)',
  },
  {
    id: 'cli',
    label: 'CLI',
    blurb: 'app-server · 스레드/승인 API · Whisper용 API 키',
  },
];

let userDataPath = null;

function setUserDataPath(p) {
  userDataPath = p;
}

function configPath() {
  if (!userDataPath) throw new Error('connection-mode: userDataPath not set');
  return path.join(userDataPath, 'connection-mode.json');
}

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (data?.mode === 'desktop' || data?.mode === 'cli') return data;
  } catch {
    /* missing */
  }
  return { mode: null };
}

function write(patch) {
  const next = { ...read(), ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return next;
}

function listModes() {
  return MODES.map((m) => ({ ...m }));
}

function getMode() {
  return read().mode; // 'desktop' | 'cli' | null
}

function hasModeChoice() {
  return getMode() === 'desktop' || getMode() === 'cli';
}

function setMode(id) {
  if (id !== 'desktop' && id !== 'cli') {
    throw new Error(`invalid mode: ${id}`);
  }
  return write({ mode: id });
}

function resolveMode() {
  return getMode() || 'desktop';
}

module.exports = {
  setUserDataPath,
  listModes,
  getMode,
  setMode,
  hasModeChoice,
  resolveMode,
  MODES,
};
