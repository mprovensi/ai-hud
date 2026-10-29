// A API do Ollama mede as durações em nanossegundos.
function generationMetrics(response) {
  if (!response || response.error) return null;
  const read = (key) => typeof response[key] === 'number' && Number.isFinite(response[key]) && response[key] >= 0 ? response[key] : null;
  const inputTokens = read('prompt_eval_count');
  const outputTokens = read('eval_count');
  const duration = read('eval_duration');
  const total = read('total_duration');
  if (inputTokens == null && outputTokens == null && duration == null && total == null) return null;
  return {
    inputTokens, outputTokens,
    tokensPerSecond: outputTokens != null && duration > 0 ? outputTokens * 1e9 / duration : null,
    generationMs: duration == null ? null : duration / 1e6,
    totalMs: total == null ? null : total / 1e6,
  };
}

module.exports = { generationMetrics };
