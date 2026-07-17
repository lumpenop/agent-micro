/**
 * Offline license keys for Gumroad (etc.) fulfillment.
 * Format: AM-XXXX-XXXX-XXXX-XXXX (8 hex body + 8 hex HMAC)
 * Generate: node scripts/gen-license.js
 * Override secret: AGENT_MICRO_LICENSE_SECRET
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Change before shipping — or set AGENT_MICRO_LICENSE_SECRET */
const DEFAULT_SECRET = 'agent-micro-license-v1-change-before-ship';

let userDataDir = null;

function setUserDataPath(dir) {
  userDataDir = dir;
}

function secret() {
  return process.env.AGENT_MICRO_LICENSE_SECRET || DEFAULT_SECRET;
}

function licensePath() {
  return path.join(userDataDir || require('os').tmpdir(), 'license.json');
}

function normalize(key) {
  return String(key || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function formatKey(body, sig) {
  const raw = `${body}${sig}`.toUpperCase();
  return `AM-${raw.match(/.{1,4}/g).join('-')}`;
}

function signBody(body) {
  return crypto.createHmac('sha256', secret()).update(body).digest('hex').slice(0, 8);
}

function verifyOffline(key) {
  const n = normalize(key);
  if (!n.startsWith('AM') || n.length !== 18) return false;
  const body = n.slice(2, 10).toLowerCase();
  const sig = n.slice(10, 18).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(body) || !/^[0-9a-f]{8}$/.test(sig)) return false;
  return sig === signBody(body);
}

function generateKey() {
  const body = crypto.randomBytes(4).toString('hex');
  return formatKey(body, signBody(body));
}

function readStore() {
  try {
    if (userDataDir && fs.existsSync(licensePath())) {
      return JSON.parse(fs.readFileSync(licensePath(), 'utf8'));
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeStore(data) {
  try {
    if (!userDataDir) return;
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(licensePath(), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function isLicensed() {
  const store = readStore();
  if (!store?.key) return false;
  return verifyOffline(store.key);
}

function getStatus() {
  const store = readStore();
  const licensed = isLicensed();
  return {
    licensed,
    key: licensed && store?.key ? formatDisplay(store.key) : null,
    activatedAt: licensed ? store?.activatedAt || null : null,
  };
}

function formatDisplay(key) {
  const n = normalize(key);
  if (!n.startsWith('AM') || n.length !== 18) return key;
  return formatKey(n.slice(2, 10), n.slice(10, 18));
}

/**
 * @param {string} key
 * @returns {{ ok: boolean, error?: string, licensed?: boolean, key?: string }}
 */
function activate(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return { ok: false, error: 'empty', errorKey: 'trial.emptyKey' };
  if (!verifyOffline(trimmed)) return { ok: false, error: 'invalid', errorKey: 'trial.badKey' };

  const display = formatDisplay(trimmed);
  writeStore({
    key: display,
    activatedAt: new Date().toISOString(),
  });
  return { ok: true, licensed: true, key: display };
}

module.exports = {
  setUserDataPath,
  isLicensed,
  getStatus,
  activate,
  verifyOffline,
  generateKey,
  normalize,
};
