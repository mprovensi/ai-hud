const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const app = require('../helpers/app-source');

// levelColor e as cores que ele usa, como saem no app.js dos aparelhos
function loadLevelColor() {
  const colors = app.match(/var COLORS = [^;]+;/)[0];
  const level = app.match(/var STATUS = [\s\S]*?function levelColor[\s\S]*?return STATUS\.ok;\s*\}/)[0];
  const context = {};
  vm.runInNewContext(colors + '\n' + level, context);
  return context;
}

test('semáforo suave em 3 faixas sólidas: < 50% verde (#5ea87e), 50–84% âmbar (#d9a441), >= 85% coral (#d95b5b)', () => {
  const { levelColor, STATUS } = loadLevelColor();
  assert.equal(STATUS.ok, '#5ea87e');
  assert.equal(STATUS.warn, '#d9a441');
  assert.equal(STATUS.crit, '#d95b5b');

  assert.equal(levelColor(0), '#5ea87e');
  assert.equal(levelColor(30), '#5ea87e');
  assert.equal(levelColor(49.9), '#5ea87e');

  assert.equal(levelColor(50), '#d9a441');
  assert.equal(levelColor(68), '#d9a441');
  assert.equal(levelColor(84.9), '#d9a441');

  assert.equal(levelColor(85), '#d95b5b');
  assert.equal(levelColor(95), '#d95b5b');
  assert.equal(levelColor(100), '#d95b5b');
});

test('valores fora de 0–100 ou ausentes não quebram a cor', () => {
  const { levelColor, STATUS } = loadLevelColor();
  assert.equal(levelColor(-20), STATUS.ok);
  assert.equal(levelColor(undefined), STATUS.ok);
  assert.equal(levelColor(NaN), STATUS.ok);
  assert.equal(levelColor(250), STATUS.crit);
  for (let p = 0; p <= 100; p += 0.5) assert.match(levelColor(p), /^#[0-9a-f]{6}$/);
});

test('as cores de estado não repetem a cor de nenhuma IA', () => {
  const { STATUS, COLORS } = loadLevelColor();
  for (const c of Object.values(STATUS)) assert.ok(!COLORS.includes(c), c);
});
