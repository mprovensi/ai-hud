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

test('a cor da cota fica verde até 30%, chega ao âmbar em 55% e ao coral em 80%', () => {
  const { levelColor, STATUS } = loadLevelColor();
  assert.equal(levelColor(0), STATUS.ok);
  assert.equal(levelColor(30), STATUS.ok);
  assert.equal(levelColor(55), STATUS.warn);
  // Em 50% o tom amarelado já prevalece (mais perto do âmbar que do verde)
  const at50 = rgb(levelColor(50)), a = rgb(STATUS.ok), w = rgb(STATUS.warn);
  assert.ok(at50[0] > (a[0] + w[0]) / 2, levelColor(50));
  // Entre 55% e 80%, passa pelo laranja até chegar ao coral
  const mid2 = rgb(levelColor(68)), c = rgb(STATUS.crit);
  assert.ok(mid2[1] < w[1] && mid2[1] > c[1], levelColor(68));
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
