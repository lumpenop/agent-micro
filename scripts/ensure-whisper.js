/**
 * Ensure local Whisper assets for Agent Micro voice:
 * - assets/bin/<platform-arch>/whisper-cli (vendored when present)
 * - assets/models/ggml-base.bin (downloaded from Hugging Face if missing)
 *
 * Safe to run from postinstall. Network failure → warn, exit 0 (macOS dictation still works).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const root = path.join(__dirname, '..');
const modelsDir = path.join(root, 'assets', 'models');
const modelPath = path.join(modelsDir, 'ggml-base.bin');
const MODEL_URL =
  process.env.AGENT_MICRO_WHISPER_MODEL_URL ||
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
/** ggml-base.bin is ~142MB — reject tiny/HTML error pages */
const MIN_BYTES = 100 * 1024 * 1024;

const key = `${process.platform}-${process.arch}`;
const whisperCli = path.join(root, 'assets', 'bin', key, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');

function log(...args) {
  console.log('[ensure-whisper]', ...args);
}

function warn(...args) {
  console.warn('[ensure-whisper]', ...args);
}

function modelOk(file = modelPath) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size >= MIN_BYTES;
  } catch {
    return false;
  }
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      reject(new Error('too many redirects'));
      return;
    }
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(
      url,
      {
        headers: { 'User-Agent': 'agent-micro-ensure-whisper' },
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          download(next, dest, redirects + 1).then(resolve, reject);
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new Error(`HTTP ${code} for ${url}`));
          return;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = `${dest}.partial`;
        const out = fs.createWriteStream(tmp);
        let bytes = 0;
        let lastLog = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          const now = Date.now();
          if (now - lastLog > 1500) {
            lastLog = now;
            log(`downloading… ${(bytes / (1024 * 1024)).toFixed(1)} MB`);
          }
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            try {
              if (bytes < MIN_BYTES) {
                fs.unlinkSync(tmp);
                reject(new Error(`download too small (${bytes} bytes) — expected ≥ ${MIN_BYTES}`));
                return;
              }
              fs.renameSync(tmp, dest);
              resolve(bytes);
            } catch (e) {
              reject(e);
            }
          });
        });
        out.on('error', (e) => {
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          reject(e);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10 * 60 * 1000, () => {
      req.destroy(new Error('download timeout'));
    });
  });
}

async function main() {
  if (fs.existsSync(whisperCli)) {
    log(`cli ok · ${path.relative(root, whisperCli)}`);
  } else {
    warn(`cli missing · ${path.relative(root, whisperCli)} (vendored per-arch; local Whisper needs it)`);
  }

  if (modelOk()) {
    const mb = (fs.statSync(modelPath).size / (1024 * 1024)).toFixed(1);
    log(`model ok · ggml-base.bin (${mb} MB)`);
    return;
  }

  log(`model missing · downloading ggml-base.bin (~142 MB)`);
  log(MODEL_URL);
  try {
    const bytes = await download(MODEL_URL, modelPath);
    log(`model ready · ${(bytes / (1024 * 1024)).toFixed(1)} MB → ${path.relative(root, modelPath)}`);
  } catch (e) {
    warn(`model download failed: ${e.message}`);
    warn('local Whisper will be unavailable until the model is present.');
    warn(`manual: curl -L -o "${modelPath}" "${MODEL_URL}"`);
  }
}

main().catch((e) => {
  warn(e.message || e);
  process.exit(0);
});
