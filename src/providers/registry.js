const PROVIDERS = [
  {
    id: 'codex',
    label: 'Codex',
    blurb: 'OpenAI · ChatGPT 계정',
    installHint: 'pnpm install 로 @openai/codex 포함',
    loginHint: 'Connect 시 브라우저 로그인',
  },
  {
    id: 'claude',
    label: 'Claude',
    blurb: 'Anthropic · Claude Code',
    installHint: 'https://claude.ai/download 또는 claude CLI',
    loginHint: '터미널에서 claude 로그인',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    blurb: 'Cursor Agent SDK',
    installHint: '@cursor/sdk + CURSOR_API_KEY',
    loginHint: 'Cursor Settings → API Keys',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    blurb: 'Google · Gemini CLI ACP',
    installHint: 'npm i -g @google/gemini-cli',
    loginHint: 'gemini 로그인 또는 API 키',
  },
];

const DEFAULT_PROVIDER = 'codex';

function listProviders() {
  return PROVIDERS.map((p) => ({ ...p }));
}

function getProviderMeta(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

function isValidProvider(id) {
  return PROVIDERS.some((p) => p.id === id);
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER,
  listProviders,
  getProviderMeta,
  isValidProvider,
};
