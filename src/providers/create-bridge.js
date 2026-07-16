/**
 * Codex-only bridge entry.
 *
 * Multi-agent picker (Claude / Cursor / Gemini / …) is intentionally NOT here.
 * When we add “어떤 걸 쓸지 고르기”, build that UI + bridges from scratch —
 * do not revive the old provider registry / provider.json switching layer.
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
  /** @deprecated use createCodexBridge */
  createBridge: createCodexBridge,
  /** @deprecated use focusCodexDesktop */
  focusProviderApp: focusCodexDesktop,
  focusChatGPT,
};
