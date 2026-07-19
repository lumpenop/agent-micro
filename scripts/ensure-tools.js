/**
 * Ensure at least one AI CLI tool is available — Codex CLI or Claude Code.
 * If a bundled Codex binary exists, or if codex/claude is on PATH, we're good.
 * Otherwise, warn the user to install one.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

function whichSync(cmd) {
  try {
    const result = execFileSync(
      process.platform === 'win32' ? 'where' : 'which',
      [cmd],
      { encoding: 'utf8', timeout: 3000 }
    );
    return String(result).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

// ── Check for CLI on PATH first ──
const codexOnPath = whichSync('codex');
const claudeOnPath = whichSync('claude');

if (codexOnPath) {
  console.log(`[ensure-tools] codex found on PATH: ${codexOnPath}`);
  process.exit(0);
}
if (claudeOnPath) {
  console.log(`[ensure-tools] claude found on PATH: ${claudeOnPath}`);
  process.exit(0);
}

// ── Fall back to bundled Codex ──
const key = `${process.platform}-${process.arch}`;
const nativeMap = {
  'darwin-arm64': path.join(root, 'node_modules', '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin', 'bin', 'codex'),
  'darwin-x64': path.join(root, 'node_modules', '@openai', 'codex-darwin-x64', 'vendor', 'x86_64-apple-darwin', 'bin', 'codex'),
};

function resolveViaRequire() {
  const pkgNames = {
    'darwin-arm64': '@openai/codex-darwin-arm64',
    'darwin-x64': '@openai/codex-darwin-x64',
    'linux-x64': '@openai/codex-linux-x64',
    'linux-arm64': '@openai/codex-linux-arm64',
    'win32-x64': '@openai/codex-win32-x64',
    'win32-arm64': '@openai/codex-win32-arm64',
  };
  const vendorBin = {
    'darwin-arm64': ['vendor', 'aarch64-apple-darwin', 'bin', 'codex'],
    'darwin-x64': ['vendor', 'x86_64-apple-darwin', 'bin', 'codex'],
    'linux-x64': ['vendor', 'x86_64-unknown-linux-musl', 'bin', 'codex'],
    'linux-arm64': ['vendor', 'aarch64-unknown-linux-musl', 'bin', 'codex'],
    'win32-x64': ['vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'],
    'win32-arm64': ['vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe'],
  };
  const pkg = pkgNames[key];
  const parts = vendorBin[key];
  if (!pkg || !parts) return null;
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`);
    const bin = path.join(path.dirname(pkgJson), ...parts);
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

const native = nativeMap[key];
const resolved = (native && fs.existsSync(native) && native) || resolveViaRequire();

let js = null;
try {
  js = require.resolve('@openai/codex/bin/codex.js');
} catch {
  const fallback = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (fs.existsSync(fallback)) js = fallback;
}

if (resolved || js) {
  console.log(`[ensure-tools] bundled Codex CLI ok · ${resolved || js}`);
  process.exit(0);
}

// ── Fall back to bundled Claude Code ──
const _claudeRoot = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
const claudeNative = path.join(_claudeRoot, 'claude');
const claudeNativeExe = path.join(_claudeRoot, 'claude.exe');
if (fs.existsSync(claudeNative)) {
  console.log(`[ensure-tools] bundled Claude Code native ok · ${claudeNative}`);
  process.exit(0);
}
if (fs.existsSync(claudeNativeExe)) {
  console.log(`[ensure-tools] bundled Claude Code native (exe) ok · ${claudeNativeExe}`);
  process.exit(0);
}

// Platform-specific native
const claudePkgName = {
  'darwin-arm64': '@anthropic-ai/claude-code-darwin-arm64',
  'darwin-x64': '@anthropic-ai/claude-code-darwin-x64',
  'linux-x64': '@anthropic-ai/claude-code-linux-x64',
  'linux-arm64': '@anthropic-ai/claude-code-linux-arm64',
  'win32-x64': '@anthropic-ai/claude-code-win32-x64',
  'win32-arm64': '@anthropic-ai/claude-code-win32-arm64',
}[key];
if (claudePkgName) {
  const claudeScope = claudePkgName.split('/')[0];
  const claudeName = claudePkgName.split('/')[1];
  const claudePlatformNative = path.join(root, 'node_modules', claudeScope, claudeName, 'bin', 'claude');
  if (fs.existsSync(claudePlatformNative)) {
    console.log(`[ensure-tools] bundled Claude Code (platform) ok · ${claudePlatformNative}`);
    process.exit(0);
  }
  // Some builds use claude.exe even on non-Windows
  const claudePlatformNativeExe = path.join(root, 'node_modules', claudeScope, claudeName, 'bin', 'claude.exe');
  if (fs.existsSync(claudePlatformNativeExe)) {
    console.log(`[ensure-tools] bundled Claude Code (platform exe) ok · ${claudePlatformNativeExe}`);
    process.exit(0);
  }
}

// Claude JS entry (cli.mjs)
let claudeJs = null;
try {
  claudeJs = require.resolve('@anthropic-ai/claude-code/cli.mjs');
} catch {
  const fallback = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.mjs');
  if (fs.existsSync(fallback)) claudeJs = fallback;
}
if (claudeJs) {
  console.log(`[ensure-tools] bundled Claude Code (JS) ok · ${claudeJs}`);
  process.exit(0);
}

// ── Nothing found ──
console.warn('[ensure-tools] No AI CLI tool found. Install one:');
console.warn('  Codex CLI:  pnpm install   (bundled via @openai/codex)');
console.warn('  Claude Code: npm i -g @anthropic-ai/claude-code');
console.warn('The app will guide you on first launch.');
process.exit(0);
