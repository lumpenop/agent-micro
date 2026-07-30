const SMALL_MODEL = 'gpt-5.6-terra';
const LARGE_MODEL = 'gpt-5.6-sol';

const COMPLEX_PATTERNS = [
  /\b(architect|architecture|migration|refactor|debug|race condition|security|performance|benchmark)\b/i,
  /(설계|아키텍처|마이그레이션|리팩터|디버그|보안|성능|경합|원인 분석)/,
  /\b(test|tests|deploy|database|concurrency|distributed|integration)\b/i,
  /(테스트|배포|데이터베이스|동시성|분산|통합)/,
];
const ACTION_PATTERNS = [
  /\b(build|implement|create|change|fix|write|update|add|remove|analyze)\b/i,
  /(구현|만들|수정|고쳐|작성|업데이트|추가|삭제|분석)/,
];
const SIMPLE_PATTERNS = [
  /^(what|why|when|where|who|define|explain|summarize)\b/i,
  /^(뭐|왜|언제|어디|누가|설명|요약|뜻|질문)/,
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function analyzePrompt(text, context = {}) {
  const prompt = String(text || '').trim();
  const chars = prompt.length;
  const lines = prompt ? prompt.split(/\r?\n/).length : 0;
  const codeBlocks = (prompt.match(/```/g) || []).length / 2;
  const fileRefs = (prompt.match(/(?:^|\s)[\w./-]+\.(?:js|ts|tsx|jsx|py|go|rs|java|json|toml|yaml|yml|md|css|html)\b/gi) || []).length;
  const enumerations = (prompt.match(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/g) || []).length;
  const complexHits = COMPLEX_PATTERNS.filter((pattern) => pattern.test(prompt)).length;
  const actionHits = ACTION_PATTERNS.filter((pattern) => pattern.test(prompt)).length;
  const simple = SIMPLE_PATTERNS.some((pattern) => pattern.test(prompt));
  const contextRatio = Number(context.contextWindow) > 0
    ? clamp(Number(context.contextTokens || 0) / Number(context.contextWindow), 0, 1)
    : 0;

  let score = 8;
  score += Math.min(24, chars / 180);
  score += Math.min(12, lines * 1.2);
  score += Math.min(18, codeBlocks * 7);
  score += Math.min(10, fileRefs * 2);
  score += Math.min(8, enumerations * 1.5);
  score += complexHits * 11;
  score += actionHits * 5;
  score += contextRatio * 14;
  if (simple && chars < 280 && !codeBlocks && complexHits === 0) score -= 8;
  score = Math.round(clamp(score, 0, 100));

  const band = score < 30 ? 'simple' : score < 62 ? 'standard' : 'complex';
  return {
    score,
    band,
    chars,
    lines,
    codeBlocks,
    fileRefs,
    contextRatio: Math.round(contextRatio * 100),
    reasons: [
      complexHits && `${complexHits} complex topic(s)`,
      actionHits && `${actionHits} action request(s)`,
      codeBlocks && `${codeBlocks} code block(s)`,
      fileRefs && `${fileRefs} file reference(s)`,
      contextRatio >= 0.6 && 'large context',
    ].filter(Boolean),
  };
}

function routeForAnalysis(analysis, settings = {}) {
  const mode = ['off', 'saver', 'balanced', 'performance'].includes(settings.auto_routing_mode)
    ? settings.auto_routing_mode : 'balanced';
  const pinnedModel = String(settings.model || '').trim();
  if (mode === 'off') {
    return {
      enabled: false,
      mode,
      model: pinnedModel || null,
      reasoning: settings.model_reasoning_effort || null,
      modelLocked: !!pinnedModel,
    };
  }

  const thresholds = {
    saver: { large: 72, medium: 54 },
    balanced: { large: 48, medium: 32 },
    performance: { large: 30, medium: 16 },
  }[mode];
  const useLarge = analysis.score >= thresholds.large;
  const reasoning = analysis.score >= 78
    ? 'high'
    : analysis.score >= thresholds.medium
      ? 'medium'
      : mode === 'saver' ? 'minimal' : 'low';
  return {
    enabled: true,
    mode,
    model: pinnedModel || (useLarge
      ? settings.routing_large_model || LARGE_MODEL
      : settings.routing_small_model || SMALL_MODEL),
    reasoning,
    modelLocked: !!pinnedModel,
    tier: useLarge ? 'large' : 'small',
  };
}

function estimateUsage(analysis, route, usage = {}) {
  const stats = usage.usageStats || {};
  const learnedMedian = Number(stats.medianTurnTokens);
  const inputTokens = Math.max(1, Math.ceil(analysis.chars / 3.6));
  const learnedBase = Number.isFinite(learnedMedian) && learnedMedian > 0
    ? learnedMedian
    : 6000;
  const complexityFactor = analysis.band === 'simple' ? 0.35 : analysis.band === 'complex' ? 1.9 : 0.85;
  const modelFactor = route.tier === 'large' ? 1.2 : 0.82;
  const reasoningFactor = { minimal: 0.55, low: 0.75, medium: 1, high: 1.35, xhigh: 1.7 }[route.reasoning] || 1;
  const center = Math.max(inputTokens * 2, learnedBase * complexityFactor * modelFactor * reasoningFactor);
  const lowTokens = Math.max(inputTokens, Math.round(center * 0.58 / 100) * 100);
  const highTokens = Math.max(lowTokens + 100, Math.round(center * 1.55 / 100) * 100);
  const todayPercent = Number(usage.usagePlan?.todayUsedPercent);
  const todayTokens = Number(usage.todayTokens);
  const tokensPerPercent = todayPercent > 0 && todayTokens > 0
    ? todayTokens / todayPercent
    : null;
  const lowPercent = tokensPerPercent ? Math.round((lowTokens / tokensPerPercent) * 10) / 10 : null;
  const highPercent = tokensPerPercent ? Math.round((highTokens / tokensPerPercent) * 10) / 10 : null;
  return {
    inputTokens,
    lowTokens,
    highTokens,
    lowPercent,
    highPercent,
    tokensPerPercent: tokensPerPercent ? Math.round(tokensPerPercent) : null,
    learnedSamples: Number(stats.sampleCount) || 0,
  };
}

function warningForEstimate(estimate, usage = {}, settings = {}) {
  const plan = usage.usagePlan || {};
  const currentUsed = Number(plan.usedPercent);
  const todayUsed = Number(plan.todayUsedPercent);
  const dailyLimit = Number(plan.limitPercent);
  const warningPercent = Number(settings.routing_warning_percent) || 80;
  const projectedPlan = Number.isFinite(estimate.highPercent) && Number.isFinite(currentUsed)
    ? currentUsed + estimate.highPercent : currentUsed;
  const projectedToday = Number.isFinite(estimate.highPercent) && Number.isFinite(todayUsed)
    ? todayUsed + estimate.highPercent : todayUsed;
  const planWarning = Number.isFinite(projectedPlan) && projectedPlan >= warningPercent;
  const dailyWarning = settings.routing_confirm_daily_overage !== false
    && plan.enabled
    && Number.isFinite(projectedToday)
    && Number.isFinite(dailyLimit)
    && projectedToday >= dailyLimit;
  return {
    required: planWarning || dailyWarning,
    planWarning,
    dailyWarning,
    projectedPlan: Number.isFinite(projectedPlan) ? Math.round(projectedPlan * 10) / 10 : null,
    projectedToday: Number.isFinite(projectedToday) ? Math.round(projectedToday * 10) / 10 : null,
  };
}

function preflightPrompt(text, settings, usage) {
  const current = usage.current || {};
  const analysis = analyzePrompt(text, {
    contextTokens: current.lastTokens,
    contextWindow: current.contextWindow,
  });
  const route = routeForAnalysis(analysis, settings);
  const estimate = estimateUsage(analysis, route, usage);
  const warning = warningForEstimate(estimate, usage, settings);
  return { analysis, route, estimate, warning };
}

module.exports = {
  analyzePrompt,
  estimateUsage,
  preflightPrompt,
  routeForAnalysis,
  warningForEstimate,
};
