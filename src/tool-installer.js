const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org';
const REGISTRY_URL = String(process.env.AGENT_MICRO_TOOL_REGISTRY_URL || DEFAULT_REGISTRY_URL).replace(/\/$/, '');
const PINNED_VERSIONS = Object.freeze({ codex: '0.144.5' });

let userDataDir = null;
const activeInstalls = new Map();

function platformSpec(provider) {
  const key = `${process.platform}-${process.arch}`;
  if (key !== 'darwin-arm64') throw new Error(`Managed ${provider} install is not available for ${key}`);
  if (provider === 'codex') {
    const base = PINNED_VERSIONS.codex;
    return {
      provider,
      packageName: '@openai/codex',
      version: `${base}-darwin-arm64`,
      integrity: 'sha512-zcT6NfBCqLFt+BReNSETTZW6v6PdbH0dzNtm9j7l7mDGqwPbKZDGJdnpkBao2389I0ZacyIKgSZoI0vez1d4Dw==',
      executable: ['vendor', 'aarch64-apple-darwin', 'bin', 'codex'],
    };
  }
  throw new Error(`Unknown provider: ${provider}`);
}

function setUserDataPath(dir) {
  userDataDir = dir;
  refreshEnvironment();
}

function installDirectory(spec) {
  if (!userDataDir) throw new Error('Tool storage is not initialized');
  return path.join(userDataDir, 'tools', spec.provider, spec.version);
}

function findInstalled(provider) {
  try {
    const spec = platformSpec(provider);
    const executable = path.join(installDirectory(spec), ...spec.executable);
    fs.accessSync(executable, fs.constants.X_OK);
    return executable;
  } catch {
    return null;
  }
}

function refreshEnvironment() {
  const codex = findInstalled('codex');
  if (codex) process.env.AGENT_MICRO_CODEX_BIN = codex;
  else delete process.env.AGENT_MICRO_CODEX_BIN;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : require('http');
    const request = client.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'agent-micro-installer' } }, (response) => {
      if ((response.statusCode || 0) !== 200) {
        response.resume();
        reject(new Error(`Package metadata failed (HTTP ${response.statusCode || 0})`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Invalid package metadata')); }
      });
    });
    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error('Package metadata timed out')));
  });
}

function download(url, destination, integrity, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many package download redirects'));
    const client = url.startsWith('https:') ? https : require('http');
    const request = client.get(url, { headers: { 'User-Agent': 'agent-micro-installer' } }, (response) => {
      const code = response.statusCode || 0;
      if (code >= 300 && code < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), destination, integrity, onProgress, redirects + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        response.resume();
        reject(new Error(`Package download failed (HTTP ${code})`));
        return;
      }
      const [algorithm, expected] = String(integrity || '').split('-', 2);
      if (!algorithm || !expected || !['sha512', 'sha256'].includes(algorithm)) {
        response.resume();
        reject(new Error('Package registry did not provide supported integrity metadata'));
        return;
      }
      const hash = crypto.createHash(algorithm);
      const output = fs.createWriteStream(destination);
      const total = Number(response.headers['content-length']) || 0;
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        onProgress?.({ phase: 'download', received, total, percent: total ? Math.floor((received / total) * 100) : null });
      });
      response.pipe(output);
      output.on('finish', () => output.close(() => {
        const actual = hash.digest('base64');
        if (actual !== expected) {
          try { fs.unlinkSync(destination); } catch {}
          reject(new Error(`Downloaded package failed integrity verification (${actual.slice(0, 12)} != ${expected.slice(0, 12)})`));
        } else resolve(received);
      }));
      output.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(10 * 60 * 1000, () => request.destroy(new Error('Package download timed out')));
  });
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || ''));
    });
  });
}

async function install(provider, onProgress) {
  const existing = findInstalled(provider);
  if (existing) return { ok: true, path: existing, downloaded: false };
  if (activeInstalls.has(provider)) return activeInstalls.get(provider);

  const task = (async () => {
    const spec = platformSpec(provider);
    onProgress?.({ phase: 'metadata', percent: 0 });
    const encodedName = encodeURIComponent(spec.packageName);
    const metadata = await getJson(`${REGISTRY_URL}/${encodedName}/${encodeURIComponent(spec.version)}`);
    const tarball = metadata?.dist?.tarball;
    const integrity = metadata?.dist?.integrity;
    if (!tarball || !integrity) throw new Error('Package download information is unavailable');
    if (REGISTRY_URL === DEFAULT_REGISTRY_URL && integrity !== spec.integrity) {
      throw new Error('Package registry integrity does not match the pinned release');
    }

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `agent-micro-${provider}-`));
    const archive = path.join(temporary, 'package.tgz');
    const extracted = path.join(temporary, 'extracted');
    try {
      fs.mkdirSync(extracted, { recursive: true });
      await download(tarball, archive, REGISTRY_URL === DEFAULT_REGISTRY_URL ? spec.integrity : integrity, onProgress);
      onProgress?.({ phase: 'install', percent: 100 });
      const listing = await run('/usr/bin/tar', ['-tzf', archive]);
      const unsafe = listing.split(/\r?\n/).filter(Boolean).some((entry) => entry.startsWith('/') || entry.split('/').includes('..'));
      if (unsafe) throw new Error('Package contains unsafe paths');
      await run('/usr/bin/tar', ['-xzf', archive, '-C', extracted]);
      const source = path.join(extracted, 'package');
      const destination = installDirectory(spec);
      const executable = path.join(source, ...spec.executable);
      if (!fs.existsSync(executable)) throw new Error('Downloaded package does not contain the expected executable');
      fs.chmodSync(executable, 0o755);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(source, destination);
      refreshEnvironment();
      return { ok: true, path: findInstalled(provider), downloaded: true, version: spec.version };
    } finally {
      try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {}
    }
  })().finally(() => activeInstalls.delete(provider));

  activeInstalls.set(provider, task);
  return task;
}

module.exports = { PINNED_VERSIONS, findInstalled, install, setUserDataPath };
