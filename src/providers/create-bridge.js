/** Codex CLI bridge factory. */
const { CodexBridge, focusChatGPT } = require('./codex-bridge');

function createCodexBridge() {
  return new CodexBridge();
}

function createApiBridge() {
  // Custom APIs run through Codex CLI so Agent Micro keeps sandbox,
  // approvals, terminal sessions, fork, and review.
  return new CodexBridge({ customProvider: true });
}

function focusCodexDesktop() {
  focusChatGPT();
}

/**
 * Create a bridge for the given provider.
 * @param {'codex'|'api'} provider
 */
function createBridge(provider = 'codex') {
  return provider === 'api' ? createApiBridge() : createCodexBridge();
}

module.exports = {
  createCodexBridge,
  createApiBridge,
  createBridge,
  focusCodexDesktop,
  focusProviderApp: focusCodexDesktop,
  focusChatGPT,
};
