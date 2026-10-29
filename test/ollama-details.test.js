const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = require('./helpers/app-source');
const start = app.indexOf('  function ollamaRuntime(d)');
const end = app.indexOf('\n  // ---- Resposta rápida', start);
assert.ok(start >= 0 && end > start);

function client(ollamas) {
  let html = '';
  const nodes = { moreToggle: {}, more: {} };
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const context = { snap: { ollamas }, moreOpen: false, sessHead: () => '',
    stat: (value, label) => '<div>' + value + ' ' + label + '</div>', esc: escape,
    k: (n) => String(n), dur: (ms) => Math.floor(ms / 60000) + 'min',
    when: (t) => new Date(t).toISOString(), hm: () => '12:00', gb: (bytes) => (bytes / 1e9).toFixed(1) + ' GB',
    $: (id) => nodes[id] || null, setOverlay: (value) => { html = value; }, bindReply: () => {}, replyBox: () => '',
    isSeen: () => false, rememberViewed: () => {} };
  vm.runInNewContext(app.slice(start, end) + '\nthis.renderDetail = renderDetail; this.ollamaRuntime = ollamaRuntime;', context);
  return { context, render: (d) => { context.renderDetail(d); return html; } };
}

function detail(overrides = {}) {
  return { id: 'm0:ollama-run-1234', machine: 'remote', tool: 'Ollama', where: 'ollama-run',
    now: 180000, start: 60000, end: 120000, state: 'waiting', models: ['test:latest'],
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: 0, contextWindow: 0,
    prompts: 0, toolCalls: 0, subagents: 0, tools: [], turns: [], lastPrompt: 'pergunta', ...overrides };
}

test('remote terminal shows useful details without unavailable CLI counters', () => {
  const c = client([{ machine: 'local', online: true, version: 'wrong-machine', installed: 9, models: [] },
    { machine: 'remote', online: true, version: 'test-version', installed: 3, models: [] }]);
  const html = c.render(detail());
  for (const text of ['Terminal', '2min', 'Processo (PID)', '1234', 'test:latest', 'test-version',
    'Modelos instalados', 'Não carregado', 'histórico compartilhado']) assert.ok(html.includes(text), text);
  for (const text of ['tokens novos', 'lidos do cache', 'gravados no cache', 'ferramentas usadas', 'subagentes', 'wrong-machine']) assert.ok(!html.includes(text), text);
});

test('loaded model exposes real memory and GPU readings and escapes model names', () => {
  const c = client([{ machine: 'remote', online: true, models: [{ name: '<model>:latest', params: '7B', quant: 'Q4',
    size: 4e9, vram: 3e9, gpuPct: 75, expiresAt: 200000 }],
    gpu: { name: 'GPU test', util: 0, temp: 40, memUsed: 1024, memTotal: 8192 } }]);
  const html = c.render(detail({ models: ['<model>'] }));
  for (const text of ['Carregado', '7B', 'Q4', '4.0 GB', '3.0 GB', '75%', 'GPU test', '0% · 40°C', '&lt;model&gt;']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('<model>'));
});

test('app details show known conversation counts and omit invented metrics', () => {
  const c = client([]);
  const html = c.render(detail({ where: 'ollama-app', id: 'ollama-1', prompts: 8,
    history: [{ role: 'user', content: 'pergunta' }, { role: 'assistant', content: 'resposta' }] }));
  assert.ok(html.includes('8 pedidos na conversa'));
  assert.ok(html.includes('2 mensagens exibidas'));
  assert.ok(!html.includes('Processo (PID)'));
  assert.ok(!html.includes('Memória do modelo'));
  assert.ok(!html.includes('tokens novos'));
});

test('last response and measured tokens/s appear in the expanded details', () => {
  const c = client([]);
  const html = c.render(detail({ where: 'ollama-app', id: 'ollama-1', lastReply: '<resposta>',
    ollamaGeneration: { outputTokens: 100, tokensPerSecond: 50, totalMs: 3000 } }));
  assert.ok(html.includes('Última resposta'));
  assert.ok(html.includes('&lt;resposta&gt;'));
  assert.ok(html.includes('50.0 tokens/s de geração'));
  assert.ok(html.includes('3.0s tempo total da resposta'));
  assert.ok(!html.includes('<resposta>'));
});

test('other CLI detail metrics remain available', () => {
  const c = client([]);
  const html = c.render(detail({ tool: 'Codex', where: 'terminal' }));
  assert.ok(html.includes('tokens novos'));
  assert.ok(html.includes('ferramentas usadas'));
});

test('runtime is never borrowed from another machine', () => {
  const c = client([{ machine: 'a', online: true }, { machine: 'b', online: true }]);
  assert.equal(c.context.ollamaRuntime({ machine: 'unknown' }), null);
  assert.equal(c.context.ollamaRuntime({}), null);
});
