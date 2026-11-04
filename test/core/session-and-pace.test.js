const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionState, ACTIVE_MS, RECENT_MS } = require('../../src/core/session');
const { pace, expired } = require('../../src/core/quota-pace');
const { usage } = require('../../src/core/usage');

test('estado da sessão pelo tempo desde a última atividade e pelo fim do turno', () => {
  const now = Date.UTC(2026, 9, 29, 12);
  const at = (ago, lastStop = '') => ({ mtime: now - ago, end: new Date(now - ago).toISOString(), lastStop });
  assert.equal(sessionState(at(10e3), now), 'working');
  assert.equal(sessionState(at(10e3, 'end_turn'), now), 'waiting');
  assert.equal(sessionState(at(ACTIVE_MS + 1000), now), 'idle');
  assert.equal(sessionState(at(RECENT_MS + 1000, 'end_turn'), now), 'closed');
  // Encerrada pelo HUD: fechada na hora; atividade depois disso (sessão retomada) reabre
  assert.equal(sessionState({ ...at(10e3, 'end_turn'), endedAt: now - 5e3 }, now), 'closed');
  assert.equal(sessionState({ ...at(10e3), endedAt: now - 60e3 }, now), 'working');
});

test('ritmo da cota: projeta pelo uso da última hora e diz quando acaba', () => {
  const now = Date.UTC(2026, 9, 29, 12);
  const w = { used: 50, resetsAt: now + 2.5 * 3600e3 }; // metade da janela de 5h já passou
  const history = { 'claude.five_hour': { resetsAt: w.resetsAt, samples: [[now - 30 * 60e3, 30], [now, 50]] } };
  const p = pace(history, 'claude', 'five_hour', w, now);
  assert.equal(p.expected, 50);
  assert.equal(p.basis, 'recent');
  assert.equal(p.projected, 150); // 20% a cada 30 min, por mais 2h30
  assert.equal(p.runsOutIn, 75 * 60e3);
  assert.equal(expired({ claude: { windows: { five_hour: w } } }, now), false);
  assert.equal(expired({ claude: { windows: { five_hour: w } } }, w.resetsAt + 1), true);
});

test('tokens de hoje e por hora somam só o que é novo (sem leitura de cache)', () => {
  const now = Date.now();
  const ts = new Date(now - 60e3).toISOString();
  const s = { tool: 'Codex', end: ts, subagent: false, events: [{ ts, fresh: 100, cacheRead: 900 }] };
  const u = usage([s], now);
  assert.equal(u.today.Codex.fresh, 100);
  assert.equal(u.today.Codex.cacheRead, 900);
  assert.equal(u.hours[23].Codex, 100);
  assert.equal(u.sessionsToday.Codex, 1);
});
