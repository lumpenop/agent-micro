const assert = require('assert');
const { percentUsedSinceDayStart, usagePlan } = require('../src/codex-usage');

const now = new Date();
const before = new Date(now);
before.setDate(before.getDate() - 1);
const morning = new Date(now);
morning.setHours(8, 0, 0, 0);
const noon = new Date(now);
noon.setHours(12, 0, 0, 0);

function event(timestamp, primary, secondary) {
  return {
    timestamp: timestamp.toISOString(),
    payload: {
      rate_limits: {
        primary: { used_percent: primary },
        secondary: { used_percent: secondary },
      },
    },
  };
}

const histories = [{
  events: [
    event(before, 10, 30),
    event(morning, 12, 33),
    event(noon, 18, 38),
  ],
}];

assert.equal(percentUsedSinceDayStart(histories, 'primary', now), 8);
assert.equal(percentUsedSinceDayStart(histories, 'secondary', now), 8);

const resetAt = Math.floor(Date.now() / 1000) + (4 * 86400);
const plan = usagePlan({
  usedPercent: 40,
  resetsAt: resetAt,
  secondary: { usedPercent: 38, resetsAt: resetAt, windowMinutes: 10080 },
}, histories, { enabled: true, limitPercent: 15 });

assert.equal(plan.window, 'secondary');
assert.equal(plan.todayUsedPercent, 8);
assert.equal(plan.todayRemainingPercent, 7);
assert.equal(plan.remainingPercent, 62);
assert.equal(plan.recommendedTodayPercent, 7);
assert.equal(plan.overDailyLimit, false);

const over = usagePlan({
  usedPercent: 40,
  resetsAt: resetAt,
  secondary: { usedPercent: 38, resetsAt: resetAt, windowMinutes: 10080 },
}, histories, { enabled: true, limitPercent: 5 });
assert.equal(over.overDailyLimit, true);
assert.equal(over.recommendedTodayPercent, 0);

console.log('Codex daily percentage pacing and reset planning: ok');
