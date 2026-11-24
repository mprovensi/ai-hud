const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { estimateSessionCostUsd, summarizeCosts } = require('../../src/core/pricing');
const { createFxTracker } = require('../../src/collect/fx');
const { mergeSnapshots } = require('../../src/federation/merge');

test('pricing estima custo equivalente em API por modelo e distribui em hoje/7d/30d', () => {
  const now = Date.parse('2026-11-24T15:00:00Z');
  const claude = {
    tool: 'Claude Code',
    models: ['claude-sonnet-4-6'],
    input: 1_000_000,
    output: 100_000,
    cacheRead: 1_000_000,
    cacheWrite: 0,
    end: '2026-11-24T14:30:00Z',
    events: [
      { ts: '2026-11-24T14:00:00Z', fresh: 1_100_000, cacheRead: 1_000_000 },
    ],
  };
  // Sonnet: 1M * $3 + 0.1M * $15 + 1M * $0.30 = $4.80
  const est = estimateSessionCostUsd(claude);
  assert.equal(Math.round(est.usd * 100) / 100, 4.8);

  const codexOld = {
    tool: 'Codex',
    models: ['gpt-5.3-codex'],
    input: 1_000_000,
    output: 100_000,
    cacheRead: 0,
    cacheWrite: 0,
    end: '2026-11-20T12:00:00Z',
    events: [
      { ts: '2026-11-20T12:00:00Z', fresh: 1_100_000, cacheRead: 0 },
    ],
  };
  // GPT-5 Codex: 1M * $1.25 + 0.1M * $10 = $2.25 (dentro de 7d, fora de hoje)
  const sum = summarizeCosts([claude, codexOld], now);
  assert.equal(sum.today['Claude Code'].usd, 4.8);
  assert.equal(sum.week['Claude Code'].usd, 4.8);
  assert.equal(sum.today.Codex.usd, 0);
  assert.equal(sum.week.Codex.usd, 2.25);
  assert.equal(sum.month.Codex.usd, 2.25);
});

test('createFxTracker usa fetcher, persiste cache e respeita override em config.usdToBrl', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-fx-'));
  const fx = createFxTracker({ dataDir: dir, fetcher: async () => 5.95 });
  await fx.refresh(true);
  assert.equal(fx.view().usdToBrl, 5.95);
  assert.equal(fx.view().source, 'live');

  // Nova instância carrega do cache em disco sem precisar chamar rede
  const fx2 = createFxTracker({ dataDir: dir, fetcher: async () => null });
  assert.equal(fx2.view().usdToBrl, 5.95);
  assert.equal(fx2.view().source, 'cache');

  // Override manual no config.json tem prioridade
  const fx3 = createFxTracker({ dataDir: dir, config: { usdToBrl: 6.1 }, fetcher: async () => 5.5 });
  assert.equal(fx3.view().usdToBrl, 6.1);
});

test('mergeSnapshots soma custos de Hub e Peers preservando taxa FX live', () => {
  const now = Date.parse('2026-11-24T15:00:00Z');
  const local = {
    now, tz: -180, active: [], recent: [], hours: [], days: [],
    today: { 'Claude Code': { fresh: 0, cacheRead: 0 }, Codex: { fresh: 0, cacheRead: 0 }, Gemini: { fresh: 0, cacheRead: 0 } },
    sessionsToday: { 'Claude Code': 0, Codex: 0, Gemini: 0 },
    quotas: {},
    costs: {
      usdToBrl: 5.8, fxSource: 'fallback', fxUpdatedAt: 0,
      today: { 'Claude Code': { usd: 1.5, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } },
      week: { 'Claude Code': { usd: 3.0, input: 200, output: 40, cacheRead: 0, cacheWrite: 0 } },
      month: { 'Claude Code': { usd: 5.0, input: 300, output: 60, cacheRead: 0, cacheWrite: 0 } },
    },
  };
  const peer = {
    name: 'MateusNote', i: 0, at: now,
    snap: {
      now, tz: -180, active: [], recent: [], hours: [], days: [],
      today: { 'Claude Code': { fresh: 0, cacheRead: 0 }, Codex: { fresh: 0, cacheRead: 0 }, Gemini: { fresh: 0, cacheRead: 0 } },
      sessionsToday: { 'Claude Code': 0, Codex: 0, Gemini: 0 },
      quotas: {},
      costs: {
        usdToBrl: 5.92, fxSource: 'live', fxUpdatedAt: now,
        today: { 'Claude Code': { usd: 2.25, input: 300, output: 50, cacheRead: 10, cacheWrite: 0 } },
        week: { 'Claude Code': { usd: 4.5, input: 600, output: 90, cacheRead: 20, cacheWrite: 0 } },
        month: { 'Claude Code': { usd: 8.0, input: 900, output: 120, cacheRead: 30, cacheWrite: 0 } },
      },
    },
  };
  const merged = mergeSnapshots({ local, localName: 'VPS', list: [peer], live: [peer], ollamasFor: () => [] });
  assert.equal(merged.costs.usdToBrl, 5.92);
  assert.equal(merged.costs.today['Claude Code'].usd, 3.75);
  assert.equal(merged.costs.week['Claude Code'].usd, 7.5);
  assert.equal(merged.costs.month['Claude Code'].usd, 13.0);
});
