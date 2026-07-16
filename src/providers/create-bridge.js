const { CodexBridge, focusChatGPT } = require('./codex-bridge');
const { ClaudeBridge } = require('./claude-bridge');
const { CursorBridge } = require('./cursor-bridge');
const { GeminiBridge } = require('./gemini-bridge');
const { DEFAULT_PROVIDER, isValidProvider } = require('./registry');

function createBridge(providerId) {
  const id = isValidProvider(providerId) ? providerId : DEFAULT_PROVIDER;
  switch (id) {
    case 'claude':
      return new ClaudeBridge();
    case 'cursor':
      return new CursorBridge();
    case 'gemini':
      return new GeminiBridge();
    case 'codex':
    default:
      return new CodexBridge();
  }
}

function focusProviderApp(providerId) {
  if (providerId === 'codex') {
    focusChatGPT();
    return;
  }
  const { execFile } = require('child_process');
  if (process.platform !== 'darwin') return;
  const apps = {
    claude: 'Claude',
    cursor: 'Cursor',
    gemini: 'Gemini',
  };
  const name = apps[providerId];
  if (name) execFile('open', ['-a', name], () => {});
}

module.exports = { createBridge, focusProviderApp, focusChatGPT };
