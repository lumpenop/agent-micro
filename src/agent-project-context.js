const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile'];

function recentRollouts(limit = 40) {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(root)) return [];
  const found = [];
  const dayDirs = [];
  let years = [];
  try { years = fs.readdirSync(root).filter((x) => /^\d{4}$/.test(x)).sort().reverse(); } catch {}
  for (const year of years.slice(0, 2)) {
    let months = [];
    try { months = fs.readdirSync(path.join(root, year)).filter((x) => /^\d{2}$/.test(x)).sort().reverse(); } catch {}
    for (const month of months.slice(0, 2)) {
      let days = [];
      try { days = fs.readdirSync(path.join(root, year, month)).filter((x) => /^\d{2}$/.test(x)).sort().reverse(); } catch {}
      for (const day of days) dayDirs.push(path.join(root, year, month, day));
    }
  }
  for (const dir of dayDirs.slice(0, 4)) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort().reverse().slice(0, 80); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      try { found.push({ file: full, mtime: fs.statSync(full).mtimeMs }); } catch {}
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function readEdges(file) {
  const stat = fs.statSync(file);
  const headSize = Math.min(stat.size, 65536);
  const tailSize = Math.min(stat.size, 524288);
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(headSize);
    fs.readSync(fd, head, 0, headSize, 0);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, Math.max(0, stat.size - tailSize));
    return { head: head.toString('utf8'), tail: tail.toString('utf8') };
  } finally { fs.closeSync(fd); }
}

function validDirectory(value) {
  const dir = String(value || '').trim();
  if (!path.isAbsolute(dir) || dir.startsWith('/private/tmp/') || dir.startsWith('/tmp/')) return null;
  try { return fs.statSync(dir).isDirectory() ? path.resolve(dir) : null; } catch { return null; }
}

function rootFor(candidate, fallback) {
  let current = validDirectory(candidate);
  if (!current) return null;
  const floor = validDirectory(fallback);
  while (current && current !== path.dirname(current)) {
    if (MARKERS.some((name) => fs.existsSync(path.join(current, name)))) return current;
    if (floor && current === floor) break;
    current = path.dirname(current);
  }
  return validDirectory(candidate);
}

function parseContext(file, terminalCwd) {
  let edges;
  try { edges = readEdges(file); } catch { return null; }
  const metaCwd = edges.head.match(/\"cwd\"\s*:\s*\"([^\"]+)\"/)?.[1] || null;
  const candidates = [];
  const re = /(?:\\?\"workdir\\?\"\s*:\s*\\?\"|\*\*\* (?:Update|Add) File:\s*)(\/[^\"\\\n]+)/g;
  let match;
  while ((match = re.exec(edges.tail))) candidates.push(match[1].replace(/\\\//g, '/'));
  for (let i = candidates.length - 1; i >= 0; i--) {
    let candidate = candidates[i];
    try { if (fs.statSync(candidate).isFile()) candidate = path.dirname(candidate); } catch {}
    const root = rootFor(candidate, terminalCwd);
    if (root) return { root, metaCwd };
  }
  return { root: rootFor(metaCwd, terminalCwd), metaCwd };
}

function detectActiveProject(terminalCwd) {
  const cwd = validDirectory(terminalCwd);
  const rollouts = recentRollouts();
  let fallback = null;
  for (const entry of rollouts) {
    const context = parseContext(entry.file, cwd);
    if (!context?.root) continue;
    if (!fallback) fallback = context.root;
    if (cwd && context.metaCwd && path.resolve(context.metaCwd) === cwd) return context.root;
  }
  return fallback || rootFor(cwd, cwd) || cwd;
}

function detectProjectFromRollout(file, terminalCwd) {
  return parseContext(file, validDirectory(terminalCwd))?.root || null;
}

module.exports = { detectActiveProject, detectProjectFromRollout, parseContext, rootFor };
