const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveOpenAIApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  if (process.env.OPENAI_KEY) return process.env.OPENAI_KEY.trim();
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
    /* no auth file */
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

module.exports = {
  transcribeWithWhisper,
  hasWhisperAuth,
  resolveOpenAIApiKey,
};
