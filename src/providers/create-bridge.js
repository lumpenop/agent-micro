/**
 * Bridge factory — supports Codex CLI and Claude Code CLI.
 * Pick the active provider at runtime via createBridge(provider).
 */
const { CodexBridge, focusChatGPT } = require('./codex-bridge');
const { ClaudeBridge } = require('./claude-bridge');

function createCodexBridge() {
  return new CodexBridge();
}

function createClaudeBridge() {
  return new ClaudeBridge();
}

function focusCodexDesktop() {
  focusChatGPT();
}

/**
 * Create a bridge for the given provider.
 * @param {'codex' | 'claude'} provider
 */
function createBridge(provider = 'codex') {
  switch (provider) {
    case 'claude':
      return createClaudeBridge();
    case 'codex':
    default:
      return createCodexBridge();
  }
}

module.exports = {
  createCodexBridge,
  createClaudeBridge,
  createBridge,
  focusCodexDesktop,
  focusProviderApp: focusCodexDesktop,
  focusChatGPT,
};
