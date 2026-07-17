/**
 * Local 7-day free trial. First launch stamped in userData/trial.json.
 * Clock rolled back before firstLaunchAt → treat as expired.
 * AGENT_MICRO_TRIAL_BYPASS=1 → always active (dev).
 * Valid license (see license.js) skips expiry lock.
 */
const fs = require('fs');
const path = require('path');
const license = require('./license');

const TRIAL_DAYS = 7;
/** Gumroad (or other) purchase page — unlock via license key after buy */
const SPONSOR_URL = '';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

let userDataDir = null;

function setUserDataPath(dir) {
  userDataDir = dir;
  license.setUserDataPath(dir);
}

function trialPath() {
  return path.join(userDataDir || require('os').tmpdir(), 'trial.json');
}

function bypassEnabled() {
  return process.env.AGENT_MICRO_TRIAL_BYPASS === '1';
}

function readStore() {
  try {
    if (userDataDir && fs.existsSync(trialPath())) {
      return JSON.parse(fs.readFileSync(trialPath(), 'utf8'));
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
    fs.writeFileSync(trialPath(), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function ensureFirstLaunch() {
  const existing = readStore();
  if (existing?.firstLaunchAt) return existing.firstLaunchAt;
  const firstLaunchAt = new Date().toISOString();
  writeStore({ firstLaunchAt });
  return firstLaunchAt;
}

/**
 * @returns {{
 *   active: boolean,
 *   expired: boolean,
 *   locked: boolean,
 *   licensed: boolean,
 *   firstLaunchAt: string,
 *   daysLeft: number,
 *   endsAt: string,
 *   sponsorUrl: string,
 *   trialDays: number,
 * }}
 */
function getStatus() {
  const sponsorUrl = typeof SPONSOR_URL === 'string' ? SPONSOR_URL.trim() : '';
  const lic = license.getStatus();

  if (lic.licensed) {
    const now = Date.now();
    return {
      active: true,
      expired: false,
      locked: false,
      licensed: true,
      firstLaunchAt: ensureFirstLaunch(),
      daysLeft: TRIAL_DAYS,
      endsAt: new Date(now + TRIAL_DAYS * MS_PER_DAY).toISOString(),
      sponsorUrl,
      trialDays: TRIAL_DAYS,
    };
  }

  if (bypassEnabled()) {
    const now = Date.now();
    return {
      active: true,
      expired: false,
      locked: false,
      licensed: false,
      firstLaunchAt: new Date(now).toISOString(),
      daysLeft: TRIAL_DAYS,
      endsAt: new Date(now + TRIAL_DAYS * MS_PER_DAY).toISOString(),
      sponsorUrl,
      trialDays: TRIAL_DAYS,
    };
  }

  const firstLaunchAt = ensureFirstLaunch();
  const startMs = Date.parse(firstLaunchAt);
  const now = Date.now();
  const endsAtMs = Number.isFinite(startMs) ? startMs + TRIAL_DAYS * MS_PER_DAY : now;
  const endsAt = new Date(endsAtMs).toISOString();

  // Clock rolled back before first launch → expired
  if (!Number.isFinite(startMs) || now < startMs) {
    return {
      active: false,
      expired: true,
      locked: true,
      licensed: false,
      firstLaunchAt,
      daysLeft: 0,
      endsAt,
      sponsorUrl,
      trialDays: TRIAL_DAYS,
    };
  }

  const elapsed = now - startMs;
  const expired = elapsed >= TRIAL_DAYS * MS_PER_DAY;
  const daysLeft = expired
    ? 0
    : Math.max(0, Math.ceil((endsAtMs - now) / MS_PER_DAY));

  return {
    active: !expired,
    expired,
    locked: expired,
    licensed: false,
    firstLaunchAt,
    daysLeft,
    endsAt,
    sponsorUrl,
    trialDays: TRIAL_DAYS,
  };
}

function getSponsorUrl() {
  return getStatus().sponsorUrl;
}

function isLocked() {
  return getStatus().locked;
}

module.exports = {
  TRIAL_DAYS,
  SPONSOR_URL,
  setUserDataPath,
  getStatus,
  getSponsorUrl,
  isLocked,
  activateLicense: (key) => license.activate(key),
};
