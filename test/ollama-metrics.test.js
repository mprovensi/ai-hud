const test = require('node:test');
const assert = require('node:assert/strict');
const { generationMetrics } = require('../src/ollama-metrics');

test('tokens/s uses output generation time rather than total latency', () => {
  const metrics = generationMetrics({ prompt_eval_count: 20, eval_count: 120,
    eval_duration: 3e9, total_duration: 10e9 });
  assert.equal(metrics.tokensPerSecond, 40);
  assert.equal(metrics.generationMs, 3000);
  assert.equal(metrics.totalMs, 10000);
  assert.equal(metrics.inputTokens, 20);
});

test('missing metrics and API errors do not invent performance data', () => {
  assert.equal(generationMetrics({ message: { content: 'antiga' } }), null);
  assert.equal(generationMetrics({ error: 'falhou', eval_count: 10, eval_duration: 1e9 }), null);
  assert.equal(generationMetrics({ eval_count: -1, eval_duration: NaN }), null);
  assert.equal(generationMetrics({ eval_count: 10, eval_duration: 0 }).tokensPerSecond, null);
  assert.equal(generationMetrics({ eval_count: 10 }).tokensPerSecond, null);
});
