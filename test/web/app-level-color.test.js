const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const app = require('../helpers/app-source');

// levelColor e as cores que ele usa, como saem no app.js dos aparelhos
function loadLevelColor() {
  const colors = app.match(/var COLORS = [^;]+;/)[0];
  const level = app.match(/var STATUS = [\s\S]*?function levelColor[\s\S]*?return out;\s*\}/)[0];
  const context = {};
  vm.runInNewContext(colors + '\n' + level, context);
  return context;
}

const rgb = (hex) => [16, 8, 0].map((sh) => (parseInt(hex.slice(1), 16) >> sh) & 255);

test('a cor da cota fica azul até 50% e vai ao vermelho, cheio a partir de 80%', () => {
  const { levelColor, STATUS } = loadLevelColor();
  assert.equal(levelColor(0), STATUS.ok);
  assert.equal(levelColor(50), STATUS.ok);
  // No meio, a mistura dos dois: cada canal entre o do azul e o do vermelho
  const mid = rgb(levelColor(65)), a = rgb(STATUS.ok), b = rgb(STATUS.crit);
  mid.forEach((c, i) => assert.ok(c > Math.min(a[i], b[i]) && c < Math.max(a[i], b[i]), levelColor(65)));
  assert.equal(levelColor(80), STATUS.crit);
  assert.equal(levelColor(100), STATUS.crit);
});

test('a cor muda aos poucos: 1 ponto a mais de cota nunca dá um salto de cor', () => {
  const { levelColor } = loadLevelColor();
  for (let p = 1; p <= 100; p++) {
    const a = rgb(levelColor(p - 1)), b = rgb(levelColor(p));
    const jump = Math.max(...a.map((c, i) => Math.abs(c - b[i])));
    assert.ok(jump <= 12, `${p - 1}% → ${p}%: ${levelColor(p - 1)} → ${levelColor(p)}`);
  }
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
