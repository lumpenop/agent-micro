const assert = require('assert');
const {
  analyzePrompt,
  preflightPrompt,
  routeForAnalysis,
} = require('../src/prompt-routing');

async function main() {
  const simple = analyzePrompt('이 함수가 무슨 뜻인지 한 문장으로 설명해줘');
  const complex = analyzePrompt(`
인증 아키텍처를 리팩터링하고 race condition 원인을 분석해줘.
- 데이터베이스 마이그레이션
- 통합 테스트와 성능 benchmark 추가
\`\`\`ts
async function login() {}
\`\`\`
`);
  assert.ok(simple.score < complex.score);
  assert.equal(routeForAnalysis(simple, { auto_routing_mode: 'balanced' }).tier, 'small');
  assert.equal(routeForAnalysis(complex, { auto_routing_mode: 'balanced' }).tier, 'large');
  assert.equal(routeForAnalysis(
    analyzePrompt('인증 아키텍처를 리팩터링하고 데이터베이스 마이그레이션, race condition 디버깅, 통합 테스트와 성능 벤치마크까지 구현해줘'),
    { auto_routing_mode: 'balanced' }
  ).tier, 'large');
  assert.equal(routeForAnalysis(complex, { auto_routing_mode: 'balanced', model: 'pinned-model' }).model, 'pinned-model');

  const preflight = preflightPrompt('복잡한 보안 마이그레이션을 구현하고 테스트해줘', {
    auto_routing_mode: 'balanced',
    routing_small_model: 'small',
    routing_large_model: 'large',
    routing_warning_percent: 80,
    routing_confirm_daily_overage: true,
  }, {
    current: { lastTokens: 12000, contextWindow: 100000 },
    todayTokens: 100000,
    usageStats: { sampleCount: 12, medianTurnTokens: 10000 },
    usagePlan: {
      enabled: true,
      usedPercent: 79,
      todayUsedPercent: 14,
      limitPercent: 15,
    },
  });
  assert.ok(preflight.estimate.highTokens > preflight.estimate.lowTokens);
  assert.equal(preflight.warning.required, true);
  assert.ok(preflight.estimate.learnedSamples >= 12);

  const { CodexBridge } = require('../src/providers/codex-bridge');
  const bridge = new CodexBridge();
  bridge.connected = true;
  bridge.agents[0] = {
    name: 'test', status: 'idle', cwd: process.cwd(), threadId: 'thread-test',
    model: 'small', reasoning: 'low', reasoningIndex: 1,
  };
  bridge.request = async (method, params) => {
    assert.equal(method, 'thread/settings/update');
    assert.equal(params.model, 'large');
    assert.equal(params.effort, 'high');
    return {};
  };
  const applied = await bridge.applyRouting({ model: 'large', reasoning: 'high' });
  assert.equal(applied.ok, true);
  assert.equal(applied.modelApplied, true);
  assert.equal(bridge.agents[0].model, 'large');
  assert.equal(bridge.agents[0].reasoning, 'high');

  const launchBridge = new CodexBridge();
  const queued = await launchBridge.applyRouting({ model: 'large', reasoning: 'medium' });
  assert.equal(queued.mode, 'next-launch');
  assert.deepEqual(launchBridge._pendingRouting.get(0), { model: 'large', reasoning: 'medium' });

  console.log('Prompt complexity routing, learned estimates and warnings: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
