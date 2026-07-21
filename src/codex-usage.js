const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionsRoot = () => path.join(os.homedir(), '.codex', 'sessions');

function recentRollouts(limit = 160) {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return [];
  const found = [];
  let years = [];
  try { years = fs.readdirSync(root).filter((v) => /^\d{4}$/.test(v)).sort().reverse(); } catch { return []; }
  for (const year of years.slice(0, 2)) {
    let months = [];
    try { months = fs.readdirSync(path.join(root, year)).filter((v) => /^\d{2}$/.test(v)).sort().reverse(); } catch { continue; }
    for (const month of months.slice(0, 12)) {
      let days = [];
      try { days = fs.readdirSync(path.join(root, year, month)).filter((v) => /^\d{2}$/.test(v)).sort().reverse(); } catch { continue; }
      for (const day of days) {
        const dir = path.join(root, year, month, day);
        let names = [];
        try { names = fs.readdirSync(dir).filter((v) => v.endsWith('.jsonl')); } catch { continue; }
        for (const name of names) {
          const file = path.join(dir, name);
          try { found.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch {}
        }
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function lastUsage(file) {
  let text;
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, Math.max(0, stat.size - size));
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }
  const lines = text.split('\n').reverse();
  for (const line of lines) {
    if (!line.includes('"type":"token_count"')) continue;
    try {
      const row = JSON.parse(line);
      if (row?.payload?.info || row?.payload?.rate_limits) return row;
    } catch {}
  }
  return null;
}

function normalize(row, file) {
  const payload = row?.payload || {};
  const info = payload.info || {};
  const total = info.total_token_usage || {};
  const last = info.last_token_usage || {};
  const primary = payload.rate_limits?.primary || null;
  return {
    file,
    timestamp: row?.timestamp || null,
    totalTokens: Number(total.total_tokens) || 0,
    inputTokens: Number(total.input_tokens) || 0,
    cachedInputTokens: Number(total.cached_input_tokens) || 0,
    outputTokens: Number(total.output_tokens) || 0,
    reasoningOutputTokens: Number(total.reasoning_output_tokens) || 0,
    lastTokens: Number(last.total_tokens) || 0,
    contextWindow: Number(info.model_context_window) || 0,
    usedPercent: Number.isFinite(Number(primary?.used_percent)) ? Number(primary.used_percent) : null,
    windowMinutes: Number(primary?.window_minutes) || null,
    resetsAt: Number(primary?.resets_at) || null,
    planType: payload.rate_limits?.plan_type || null,
  };
}

function getUsage({ currentRolloutPath = null } = {}) {
  const entries = recentRollouts();
  const rows = entries.map(({ file }) => normalize(lastUsage(file), file)).filter((row) => row.timestamp || row.totalTokens || row.usedPercent != null);
  const current = currentRolloutPath ? rows.find((row) => row.file === currentRolloutPath) || normalize(lastUsage(currentRolloutPath), currentRolloutPath) : rows[0] || null;
  const primary = rows.find((row) => row.usedPercent != null) || null;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const sum = (prefix) => rows.reduce((total, row) => row.timestamp?.startsWith(prefix) ? total + row.totalTokens : total, 0);
  return {
    ok: true,
    source: 'Codex rollout logs',
    current,
    sessions: rows.length,
    todayTokens: sum(today),
    monthTokens: sum(month),
    rateLimit: primary ? { usedPercent: primary.usedPercent, windowMinutes: primary.windowMinutes, resetsAt: primary.resetsAt, planType: primary.planType } : null,
    checkedAt: Date.now(),
  };
}

module.exports = { getUsage };
