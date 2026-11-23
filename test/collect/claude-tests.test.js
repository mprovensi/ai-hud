const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claudeSessions } = require('../../src/collect/sources/claude');
const { buildSnapshot } = require('../../src/views/snapshot');
const { buildSessionDetail } = require('../../src/views/session-detail');

// Log do Claude Code com um comando por turno: [comando, saída, is_error]
function writeSession(home, runs) {
  const dir = path.join(home, '.claude', 'projects', 'app');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  runs.forEach(([command, output, isError], i) => {
    const ts = new Date(Date.UTC(2026, 10, 5, 12, i)).toISOString();
    lines.push({ type: 'assistant', timestamp: ts, cwd: '/app', requestId: 'r' + i, message: { id: 'm' + i, model: 'claude-x',
      usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 't' + i, name: 'Bash', input: { command } }] } });
    lines.push({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: 't' + i, is_error: isError, content: output }] } });
  });
  fs.writeFileSync(path.join(dir, 'sess.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
}

function snapshotCard(home) {
  const sessions = claudeSessions({ home });
  const quotas = { view: () => ({}), burn: () => ({}) };
  const snap = buildSnapshot({ sessions, now: Date.UTC(2026, 10, 5, 13), quotas, pendingInfo: () => ({}), ollamaState: () => null });
  return { session: sessions[0], card: [...snap.active, ...snap.recent][0] };
}

test('teste que falhou numa sessão do Claude deixa o cartão em vermelho, com o comando e o erro', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-tests-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeSession(home, [['git status', 'limpo', false], ['npm test', 'not ok 1 - soma\n  error: esperado 2\n# pass 3\n# fail 1', true]]);
  const { session, card } = snapshotCard(home);
  assert.equal(card.testFailed, true);
  assert.equal(session.testRun.command, 'npm test');
  assert.match(session.testRun.summary, /esperado 2/);
});

test('um teste que passa depois da falha tira o vermelho', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-tests-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeSession(home, [['npm test', '# pass 3\n# fail 1', true], ['npm test 2>&1 | tail -2', '# pass 4\n# fail 0', false]]);
  assert.equal(snapshotCard(home).card.testFailed, false);
});

test('Claude registra arquivos modificados (Edit/Write) em ordem do mais recente no detalhe da sessão', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-files-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'projects', 'app');
  fs.mkdirSync(dir, { recursive: true });
  const ts = '2026-11-05T12:00:00.000Z';
  const lines = [
    { type: 'assistant', timestamp: ts, cwd: '/app', requestId: 'r1', message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/app/src/a.js' } },
        { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/app/src/b.js' } },
        { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/app/src/a.js' } },
      ] } },
  ];
  fs.writeFileSync(path.join(dir, 'sess.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  const s = claudeSessions({ home })[0];
  const detail = buildSessionDetail(s, Date.parse(ts) + 1000, () => ({}));
  assert.deepEqual(detail.files, [['src/a.js', 2], ['src/b.js', 1]]);
});
