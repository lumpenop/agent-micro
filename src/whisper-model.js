const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const MODEL_NAME = 'ggml-base.bin';
const MODEL_URL = process.env.AGENT_MICRO_WHISPER_MODEL_URL
  || 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const MODEL_SHA256 = process.env.AGENT_MICRO_WHISPER_MODEL_SHA256
  || '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';
const MIN_BYTES = 100 * 1024 * 1024;

let userDataDir = null;
let activeDownload = null;
const validationCache = new Map();

function setUserDataPath(dir) {
  userDataDir = dir;
}

function downloadedModelPath() {
  if (!userDataDir) throw new Error('Whisper model storage is not initialized');
  return path.join(userDataDir, 'models', MODEL_NAME);
}

function validModel(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < MIN_BYTES) return false;
    const cached = validationCache.get(file);
    if (cached?.size === stat.size && cached?.mtime === stat.mtimeMs) return cached.valid;
    const hash = crypto.createHash('sha256');
    const descriptor = fs.openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let bytes = 0;
      do {
        bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytes) hash.update(buffer.subarray(0, bytes));
      } while (bytes);
    } finally {
      fs.closeSync(descriptor);
    }
    const valid = hash.digest('hex') === MODEL_SHA256;
    validationCache.set(file, { size: stat.size, mtime: stat.mtimeMs, valid });
    return valid;
  } catch {
    return false;
  }
}

function bundledDevelopmentModel() {
  const file = path.join(__dirname, '..', 'assets', 'models', MODEL_NAME);
  return validModel(file) ? file : null;
}

function findModel() {
  if (userDataDir) {
    const downloaded = downloadedModelPath();
    if (validModel(downloaded)) return downloaded;
  }
  return bundledDevelopmentModel();
}

function download(url, destination, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many model download redirects'));
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { headers: { 'User-Agent': 'agent-micro-whisper' } }, (response) => {
      const code = response.statusCode || 0;
      if (code >= 300 && code < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        download(next, destination, onProgress, redirects + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        response.resume();
        reject(new Error(`Model download failed (HTTP ${code})`));
        return;
      }

      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const partial = `${destination}.partial`;
      try { fs.unlinkSync(partial); } catch {}
      const output = fs.createWriteStream(partial);
      const hash = crypto.createHash('sha256');
      const total = Number(response.headers['content-length']) || 0;
      let received = 0;

      response.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        onProgress?.({ received, total, percent: total ? Math.floor((received / total) * 100) : null });
      });
      response.pipe(output);
      output.on('finish', () => output.close(() => {
        try {
          if (received < MIN_BYTES) throw new Error('Downloaded Whisper model is incomplete');
          const digest = hash.digest('hex');
          if (digest !== MODEL_SHA256) throw new Error('Whisper model checksum mismatch');
          fs.renameSync(partial, destination);
          resolve({ path: destination, bytes: received });
        } catch (error) {
          try { fs.unlinkSync(partial); } catch {}
          reject(error);
        }
      }));
      output.on('error', (error) => {
        try { fs.unlinkSync(partial); } catch {}
        reject(error);
      });
    });
    request.on('error', reject);
    request.setTimeout(10 * 60 * 1000, () => request.destroy(new Error('Model download timed out')));
  });
}

async function ensureModel(onProgress) {
  const existing = findModel();
  if (existing) return { ok: true, path: existing, downloaded: false };
  if (!activeDownload) {
    const destination = downloadedModelPath();
    activeDownload = download(MODEL_URL, destination, onProgress)
      .then((result) => ({ ok: true, ...result, downloaded: true }))
      .finally(() => { activeDownload = null; });
  }
  return activeDownload;
}

module.exports = { ensureModel, findModel, setUserDataPath };
