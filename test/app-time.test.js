const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = app.indexOf('  function pad('), end = app.indexOf('\n  function k(', start);
const resetStart = app.indexOf('  function resetAt('), resetEnd = app.indexOf('\n  }', resetStart) + 4;

function clock(serverTime, tzMinutes) {
  const context = {};
  vm.runInNewContext(app.slice(start, end) + app.slice(resetStart, resetEnd), context);
  // Aparelho com relógio errado: a diferença para o PC vem do snapshot (now) e o fuso, de tz
  context.skew = serverTime - Date.now();
  context.tzMs = tzMinutes * 60000;
  return context;
}

test('horários seguem o fuso do PC, não o do aparelho', () => {
  const now = Date.UTC(2026, 9, 28, 12, 0); // 09:00 em UTC−3
  const c = clock(now, -180);
  assert.equal(c.hm(now), '09:00');
  assert.equal(c.when(now - 3600e3), 'às 08:00');
  assert.equal(c.when(now - 24 * 3600e3), 'ontem 09:00');
  assert.equal(c.when(now - 3 * 24 * 3600e3), '25/10 09:00');
});

test('"hoje", "amanhã" e dia da semana usam a data do PC mesmo com o relógio do aparelho errado', () => {
  const now = Date.UTC(2026, 9, 29, 2, 30); // 28/10 23:30 em UTC−3 (quarta)
  const c = clock(now, -180);
  assert.equal(c.resetAt(now + 20 * 60e3), '23:50');
  assert.equal(c.resetAt(now + 3 * 3600e3), 'amanhã 02:30');
  assert.equal(c.resetAt(now + 3 * 24 * 3600e3), 'sáb 23:30');
});
