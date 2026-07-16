const fs = require('fs');
const path = require('path');
const { DEFAULT_PROVIDER, isValidProvider } = require('./registry');

let userDataPath = null;

function setUserDataPath(p) {
  userDataPath = p;
}

function configPath() {
  if (!userDataPath) throw new Error('provider config: userDataPath not set');
  return path.join(userDataPath, 'provider.json');
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const data = JSON.parse(raw);
    if (data?.provider && isValidProvider(data.provider)) return data;
  } catch {
    /* missing / invalid */
  }
  return { provider: null };
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  if (next.provider && !isValidProvider(next.provider)) {
    throw new Error(`invalid provider: ${next.provider}`);
  }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return next;
}

function getProvider() {
  return readConfig().provider;
}

function setProvider(id) {
  if (!isValidProvider(id)) throw new Error(`invalid provider: ${id}`);
  return writeConfig({ provider: id });
}

function hasProviderChoice() {
  return !!getProvider();
}

function resolveProvider() {
  return getProvider() || DEFAULT_PROVIDER;
}

module.exports = {
  setUserDataPath,
  readConfig,
  writeConfig,
  getProvider,
  setProvider,
  hasProviderChoice,
  resolveProvider,
  DEFAULT_PROVIDER,
};
