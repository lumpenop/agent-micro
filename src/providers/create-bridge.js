/**
 * Codex CLI bridge only (app-server).
 * Multi-agent / Desktop-vs-CLI pickers are intentionally not here —
 * add those greenfield later if needed.
 */
const { CodexBridge, focusChatGPT } = require('./codex-bridge');

function createCodexBridge() {
  return new CodexBridge();
}

function focusCodexDesktop() {
  focusChatGPT();
}

module.exports = {
  createCodexBridge,
  focusCodexDesktop,
  createBridge: createCodexBridge,
  focusProviderApp: focusCodexDesktop,
  focusChatGPT,
};
