/** Codex CLI bridge factory. */
const { CodexBridge, focusChatGPT } = require('./codex-bridge');
const { OpenAICompatibleBridge } = require('./openai-compatible-bridge');

function createCodexBridge() {
  return new CodexBridge();
}

function createApiBridge() {
  return new OpenAICompatibleBridge();
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
