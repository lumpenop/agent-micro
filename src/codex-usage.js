const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionsRoot = () => path.join(os.homedir(), '.codex', 'sessions');
const usageCache = new Map();

function recentRollouts(limit = 2000) {
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

function usageEvents(file) {
  try {
    const stat = fs.statSync(file);
    const cached = usageCache.get(file);
    if (cached?.mtime === stat.mtimeMs && cached?.size === stat.size) return cached.events;
    const text = fs.readFileSync(file, 'utf8');
    const events = text.split('\n').map((line) => {
      if (!line.includes('"type":"token_count"')) return null;
      try {
        const row = JSON.parse(line);
        return row?.payload?.info || row?.payload?.rate_limits ? row : null;
      } catch { return null; }
    }).filter(Boolean);
    usageCache.set(file, { mtime: stat.mtimeMs, size: stat.size, events });
    return events;
  } catch { return []; }
}

function lastUsage(events) {
  return events[events.length - 1] || null;
}

function localDateKey(timestamp) {
  if (!timestamp) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return values.year && values.month && values.day
    ? `${values.year}-${values.month}-${values.day}` : null;
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
    secondary: payload.rate_limits?.secondary ? {
      usedPercent: Number.isFinite(Number(payload.rate_limits.secondary.used_percent)) ? Number(payload.rate_limits.secondary.used_percent) : null,
      windowMinutes: Number(payload.rate_limits.secondary.window_minutes) || null,
      resetsAt: Number(payload.rate_limits.secondary.resets_at) || null,
    } : null,
    credits: payload.rate_limits?.credits ? {
      hasCredits: payload.rate_limits.credits.has_credits === true,
      unlimited: payload.rate_limits.credits.unlimited === true,
      balance: payload.rate_limits.credits.balance ?? null,
    } : null,
    planType: payload.rate_limits?.plan_type || null,
  };
}

function normalizeRateLimits(raw) {
  const source = raw?.rateLimits || raw?.rate_limits || raw;
  if (!source || typeof source !== 'object') return null;
  const normalizeWindow = (window) => window ? {
    usedPercent: Number.isFinite(Number(window.usedPercent ?? window.used_percent))
      ? Number(window.usedPercent ?? window.used_percent) : null,
    windowMinutes: Number(window.windowDurationMins ?? window.window_minutes) || null,
    resetsAt: Number(window.resetsAt ?? window.resets_at) || null,
  } : null;
  const credits = source.rateLimitResetCredits || source.rate_limit_reset_credits;
  return {
    usedPercent: normalizeWindow(source.primary)?.usedPercent ?? null,
    windowMinutes: normalizeWindow(source.primary)?.windowMinutes || null,
    resetsAt: normalizeWindow(source.primary)?.resetsAt || null,
    secondary: normalizeWindow(source.secondary),
    credits: source.credits ? {
      hasCredits: source.credits.hasCredits === true || source.credits.has_credits === true,
      unlimited: source.credits.unlimited === true,
      balance: source.credits.balance ?? null,
    } : credits ? {
      availableCount: Number(credits.availableCount ?? credits.available_count) || 0,
      items: Array.isArray(credits.credits) ? credits.credits : null,
    } : null,
    resetCredits: credits || null,
    planType: source.planType || source.plan_type || null,
  };
}

function rateSnapshot(event, key) {
  const window = event?.payload?.rate_limits?.[key];
  const usedPercent = Number(window?.used_percent);
  if (!Number.isFinite(usedPercent)) return null;
  const timestamp = new Date(event?.timestamp).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return { timestamp, usedPercent: Math.max(0, Math.min(100, usedPercent)) };
}

function percentUsedSinceDayStart(histories, key, now = new Date()) {
  const dayKey = localDateKey(now);
  const snapshots = histories
    .flatMap(({ events }) => events.map((event) => rateSnapshot(event, key)).filter(Boolean))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!snapshots.length) return null;

  let previous = null;
  let used = 0;
  for (const snapshot of snapshots) {
    const isToday = localDateKey(snapshot.timestamp) === dayKey;
    if (!isToday) {
      if (snapshot.timestamp < now.getTime()) previous = snapshot.usedPercent;
      continue;
    }
    if (previous != null) {
      used += snapshot.usedPercent >= previous
        ? snapshot.usedPercent - previous
        : snapshot.usedPercent;
    }
    previous = snapshot.usedPercent;
  }
  return Math.max(0, Math.min(100, Math.round(used * 10) / 10));
}

function usagePlan(rateLimit, histories, { enabled = false, limitPercent = 15 } = {}) {
  const limit = Math.max(1, Math.min(100, Math.round(Number(limitPercent) || 15)));
  const window = rateLimit?.secondary?.usedPercent != null ? rateLimit.secondary : rateLimit;
  const windowKey = window === rateLimit?.secondary ? 'secondary' : 'primary';
  if (!window || window.usedPercent == null) {
    return { enabled, limitPercent: limit, available: false };
  }

  const usedPercent = Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
  const remainingPercent = Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
  const todayUsedPercent = percentUsedSinceDayStart(histories, windowKey);
  const todayRemainingPercent = enabled && todayUsedPercent != null
    ? Math.max(0, Math.round((limit - todayUsedPercent) * 10) / 10)
    : null;
  const secondsRemaining = window.resetsAt
    ? Math.max(0, Number(window.resetsAt) - Math.floor(Date.now() / 1000))
    : null;
  const pacingDays = secondsRemaining == null ? null : Math.max(1, Math.ceil(secondsRemaining / 86400));
  const evenDailyPercent = pacingDays
    ? Math.max(0, Math.round((remainingPercent / pacingDays) * 10) / 10)
    : null;
  const recommendedTodayPercent = evenDailyPercent == null
    ? todayRemainingPercent
    : enabled && todayRemainingPercent != null
      ? Math.min(todayRemainingPercent, evenDailyPercent)
      : evenDailyPercent;

  return {
    enabled,
    available: true,
    limitPercent: limit,
    window: windowKey,
    windowMinutes: window.windowMinutes || null,
    usedPercent,
    remainingPercent,
    todayUsedPercent,
    todayRemainingPercent,
    recommendedTodayPercent: recommendedTodayPercent == null
      ? null : Math.round(recommendedTodayPercent * 10) / 10,
    pacingDays,
    resetsAt: window.resetsAt || null,
    secondsRemaining,
    overDailyLimit: enabled && todayUsedPercent != null && todayUsedPercent >= limit,
  };
}

function getUsage({
  currentRolloutPath = null,
  rateLimitSnapshot = null,
  dailyLimitEnabled = false,
  dailyLimitPercent = 15,
} = {}) {
  const entries = recentRollouts();
  const activeFiles = new Set(entries.map(({ file }) => file));
  if (currentRolloutPath) activeFiles.add(currentRolloutPath);
  for (const file of usageCache.keys()) {
    if (!activeFiles.has(file)) usageCache.delete(file);
  }
  const histories = entries.map(({ file }) => ({ file, events: usageEvents(file) }));
  const rows = histories.map(({ file, events }) => normalize(lastUsage(events), file)).filter((row) => row.timestamp || row.totalTokens || row.usedPercent != null);
  const current = currentRolloutPath
    ? rows.find((row) => row.file === currentRolloutPath) || normalize(lastUsage(usageEvents(currentRolloutPath)), currentRolloutPath)
    : rows[0] || null;
  const primary = rows.find((row) => row.usedPercent != null) || null;
  const liveRate = normalizeRateLimits(rateLimitSnapshot);
  const today = localDateKey(new Date());
  const month = today.slice(0, 7);
  let todayTokens = 0;
  let monthTokens = 0;
  const recentTurnTokens = [];
  for (const { events } of histories) {
    let previousTotal = 0;
    for (const event of events) {
      const total = Number(event?.payload?.info?.total_token_usage?.total_tokens);
      if (!Number.isFinite(total)) continue;
      // total_token_usage is cumulative within a rollout. Count only the
      // increase since the preceding token_count event, not the whole total.
      const delta = total >= previousTotal ? total - previousTotal : total;
      previousTotal = total;
      const date = localDateKey(event.timestamp);
      if (date === today) todayTokens += delta;
      if (date?.startsWith(month)) monthTokens += delta;
      const lastTokens = Number(event?.payload?.info?.last_token_usage?.total_tokens);
      if (Number.isFinite(lastTokens) && lastTokens > 0) {
        recentTurnTokens.push({ timestamp: new Date(event.timestamp).getTime() || 0, tokens: lastTokens });
      }
    }
  }
  const turnValues = recentTurnTokens
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 40)
    .map(({ tokens }) => tokens)
    .sort((a, b) => a - b);
  const medianTurnTokens = turnValues.length
    ? turnValues[Math.floor(turnValues.length / 2)]
    : null;
  const rateLimit = liveRate || (primary ? {
    usedPercent: primary.usedPercent,
    windowMinutes: primary.windowMinutes,
    resetsAt: primary.resetsAt,
    secondary: primary.secondary,
    credits: primary.credits,
    planType: primary.planType,
  } : null);
  return {
    ok: true,
    source: 'Codex rollout logs',
    current,
    sessions: rows.length,
    todayTokens,
    monthTokens,
    rateLimit,
    usagePlan: usagePlan(rateLimit, histories, {
      enabled: dailyLimitEnabled,
      limitPercent: dailyLimitPercent,
    }),
    usageStats: {
      sampleCount: turnValues.length,
      medianTurnTokens,
      averageTurnTokens: turnValues.length
        ? Math.round(turnValues.reduce((sum, value) => sum + value, 0) / turnValues.length)
        : null,
    },
    checkedAt: Date.now(),
  };
}

module.exports = { getUsage, percentUsedSinceDayStart, usagePlan };
