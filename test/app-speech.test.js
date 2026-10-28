const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = app.indexOf('  function joinSpeech('), end = app.indexOf('\n  function micState', start);
const context = {};
vm.runInNewContext(app.slice(start, end), context);
const results = (...texts) => texts.map((transcript) => [{ transcript }]);

test('ditado no desktop: trechos com espaço inicial viram uma frase só', () => {
  assert.equal(context.joinSpeech(results('teste', ' de voz')), 'teste de voz');
});

test('ditado no Chrome do Android: trecho que repete o anterior o substitui, sem duplicar', () => {
  assert.equal(context.joinSpeech(results('teste', 'teste de teste de voz')), 'teste de teste de voz');
});

test('ditado: trechos sem espaço entre eles ganham espaço', () => {
  assert.equal(context.joinSpeech(results('primeira frase', 'segunda frase')), 'primeira frase segunda frase');
});
