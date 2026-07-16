const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..', 'node_modules', 'electron');
const dist = path.join(root, 'dist');
const framework = path.join(
  dist,
  'Electron.app',
  'Contents',
  'Frameworks',
  'Electron Framework.framework'
);
const pathTxt = path.join(root, 'path.txt');

if (fs.existsSync(framework) && fs.existsSync(pathTxt)) {
  process.exit(0);
}

// Prefer unzipping a cached artifact if install.js left a stub
const cacheRoot = path.join(process.env.HOME || '', 'Library', 'Caches', 'electron');
function findZip() {
  if (!fs.existsSync(cacheRoot)) return null;
  const entries = [];
  for (const dir of fs.readdirSync(cacheRoot)) {
    const full = path.join(cacheRoot, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith('.zip') && f.includes('darwin')) {
        entries.push(path.join(full, f));
      }
    }
  }
  entries.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return entries[0] || null;
}

try {
  execFileSync(process.execPath, [path.join(root, 'install.js')], {
    stdio: 'inherit',
    env: { ...process.env, force_no_cache: 'true' },
  });
} catch {
  // continue to manual unzip fallback
}

if (!fs.existsSync(framework)) {
  const zip = findZip();
  if (zip) {
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });
    execFileSync('unzip', ['-q', zip, '-d', dist], { stdio: 'inherit' });
  }
}

fs.writeFileSync(pathTxt, 'Electron.app/Contents/MacOS/Electron');
if (!fs.existsSync(framework)) {
  console.warn('Electron binary still incomplete. Run: pnpm rebuild electron');
  process.exit(0);
}
