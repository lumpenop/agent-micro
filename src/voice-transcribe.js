const fs = require('fs');
const os = require('os');
const path = require('path');

let userDataPath = null;

function setUserDataPath(p) {
  userDataPath = p;
  loadDotEnv();
}

function loadDotEnv() {
  const candidates = [
    path.join(__dirname, '..', '.env'),
    userDataPath ? path.join(userDataPath, '.env') : null,
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.+)\s*$/);
        if (!m) continue;
        let v = m[1].trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        if (v) process.env.OPENAI_API_KEY = v;
      }
    } catch {
      /* missing */
    }
  }
}

function storedPath() {
  if (!userDataPath) return null;
  return path.join(userDataPath, 'voice.json');
}

function readVoiceStore() {
  try {
    const p = storedPath();
    if (!p || !fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeVoiceStore(patch) {
  const p = storedPath();
  if (!p) throw new Error('userData not ready');
  const next = { ...readVoiceStore(), ...patch };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2));
  return next;
}

function readStoredApiKey() {
  const key = readVoiceStore().openaiApiKey;
  if (typeof key === 'string' && key.startsWith('sk-')) return key.trim();
  return null;
}

function writeStoredApiKey(key) {
  const trimmed = String(key || '').trim();
  if (trimmed && !trimmed.startsWith('sk-')) {
    throw new Error('sk- 로 시작하는 API 키를 넣어주세요');
  }
  if (!trimmed) {
    writeVoiceStore({ openaiApiKey: null, setupDone: true, setupSkipped: true });
    return { ok: true, saved: false };
  }
  writeVoiceStore({
    openaiApiKey: trimmed,
    setupDone: true,
    setupSkipped: false,
  });
  return { ok: true, saved: true };
}

function resolveOpenAIApiKey() {
  loadDotEnv();
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  if (process.env.OPENAI_KEY) return process.env.OPENAI_KEY.trim();
  const stored = readStoredApiKey();
  if (stored) return stored;
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const candidates = [
      auth.OPENAI_API_KEY,
      auth.openai_api_key,
      auth.api_key,
      auth.apiKey,
      auth?.tokens?.openai_api_key,
      auth?.token?.api_key,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.startsWith('sk-')) return c.trim();
    }
  } catch {
    /* ChatGPT 로그인만으로는 Whisper API 키가 보통 없음 */
  }
  return null;
}

/**
 * Transcribe audio with OpenAI Whisper (does not use Chromium Web Speech / Google).
 * @param {Buffer|Uint8Array} bytes
 * @param {string} mimeType
 */
async function transcribeWithWhisper(bytes, mimeType = 'audio/webm') {
  const key = resolveOpenAIApiKey();
  if (!key) {
    const err = new Error('OPENAI_API_KEY 필요');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const ext = mimeType.includes('mp4')
    ? 'mp4'
    : mimeType.includes('wav')
      ? 'wav'
      : mimeType.includes('mpeg') || mimeType.includes('mp3')
        ? 'mp3'
        : 'webm';

  const form = new FormData();
  const blob = new Blob([bytes], { type: mimeType || 'audio/webm' });
  form.append('file', blob, `speech.${ext}`);
  form.append('model', 'whisper-1');
  form.append('language', 'ko');
  form.append('response_format', 'json');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { error: { message: raw.slice(0, 200) } };
  }

  if (!res.ok) {
    const msg = data?.error?.message || `Whisper HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = 'WHISPER_HTTP';
    err.status = res.status;
    throw err;
  }

  const text = String(data?.text || '').trim();
  if (!text) {
    const err = new Error('empty transcript');
    err.code = 'EMPTY';
    throw err;
  }
  return { text, model: 'whisper-1' };
}

function hasWhisperAuth() {
  return !!resolveOpenAIApiKey();
}

/** True when Codex connect should open the mic API-key step. */
function needsVoiceSetup() {
  if (hasWhisperAuth()) return false;
  const store = readVoiceStore();
  return !store.setupDone;
}

function markVoiceSetupDone({ skipped = false } = {}) {
  writeVoiceStore({ setupDone: true, setupSkipped: !!skipped });
  return voiceStatus();
}

function voiceStatus() {
  const ready = hasWhisperAuth();
  const store = readVoiceStore();
  return {
    whisperReady: ready,
    mode: ready ? 'whisper' : 'codex-dictation',
    hasStoredKey: !!readStoredApiKey(),
    needsSetup: needsVoiceSetup(),
    setupSkipped: !!store.setupSkipped,
  };
}

module.exports = {
  setUserDataPath,
  transcribeWithWhisper,
  hasWhisperAuth,
  resolveOpenAIApiKey,
  writeStoredApiKey,
  voiceStatus,
  needsVoiceSetup,
  markVoiceSetupDone,
};
