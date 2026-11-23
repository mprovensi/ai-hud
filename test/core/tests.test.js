const test = require('node:test');
const assert = require('node:assert/strict');
const { isTestCommand, testOutcome } = require('../../src/core/tests');

test('reconhece comandos de teste, mesmo com cd, pipes e filtros em volta', () => {
  for (const c of ['npm test', 'cd /d/app && npm test 2>&1 | grep -E "^# (pass|fail)"', 'npm run test', 'node --test test/x.test.js',
    'pytest -q', 'python -m pytest tests', 'npx jest', 'npx vitest run', 'go test ./...', 'cargo test', 'dotnet test', 'mvn -q test', './gradlew test']) {
    assert.ok(isTestCommand(c), c);
  }
  for (const c of ['npm install', 'git status', 'cat test/x.test.js', 'npm run build', 'ls test', undefined]) assert.ok(!isTestCommand(c), String(c));
});

test('falha pelos resumos dos executores, mesmo quando o comando termina com sucesso', () => {
  assert.equal(testOutcome('# pass 105\n# fail 1', false).ok, false);
  assert.equal(testOutcome('not ok 3 - soma\n  error: esperado 2', false).ok, false);
  assert.equal(testOutcome('Tests:       2 failed, 40 passed, 42 total', false).ok, false);
  assert.equal(testOutcome('===== 1 failed, 10 passed in 0.5s =====', false).ok, false);
  assert.equal(testOutcome('--- FAIL: TestSoma (0.00s)\nFAIL', false).ok, false);
  assert.equal(testOutcome('[INFO] BUILD FAILURE', false).ok, false);
});

test('passa pelo resumo sem falhas, mesmo se o comando terminou com erro (ex.: grep sem achar nada)', () => {
  assert.equal(testOutcome('# pass 110\n# fail 0', true).ok, true);
  assert.equal(testOutcome('Tests:       40 passed, 40 total', false).ok, true);
  assert.equal(testOutcome('===== 12 passed in 1.2s =====', true).ok, true);
  assert.equal(testOutcome('test result: ok. 8 passed; 0 failed', false).ok, true);
});

test('sem resumo reconhecível, vale o código de saída', () => {
  assert.equal(testOutcome('Exit code 1\nalgo deu errado', true).ok, false);
  assert.equal(testOutcome('pronto', false).ok, true);
});

test('o resumo da falha traz as linhas que explicam o erro', () => {
  const r = testOutcome('TAP version 13\nok 1 - a\nnot ok 2 - soma\n  error: esperado 2, veio 3\n# pass 1\n# fail 1', false);
  assert.equal(r.ok, false);
  assert.match(r.summary, /not ok 2 - soma/);
  assert.match(r.summary, /esperado 2, veio 3/);
  assert.doesNotMatch(r.summary, /TAP version/);
});
