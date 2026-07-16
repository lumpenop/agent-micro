const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const key = `${process.platform}-${process.arch}`;
const nativeMap = {
  'darwin-arm64': path.join(
    root,
    'node_modules',
    '@openai',
    'codex-darwin-arm64',
    'vendor',
    'aarch64-apple-darwin',
    'bin',
    'codex'
  ),
  'darwin-x64': path.join(
    root,
    'node_modules',
    '@openai',
    'codex-darwin-x64',
    'vendor',
    'x86_64-apple-darwin',
    'bin',
    'codex'
  ),
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
  console.log(`[ensure-codex] ok · ${resolved || js}`);
  process.exit(0);
}

console.warn('[ensure-codex] Codex CLI missing. Run: pnpm install');
process.exit(0);
