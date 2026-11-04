const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createClose } = require('../../src/actions/close');

// Home falsa com o registro de processo da sessão; exec falso responde a hora de início e grava os comandos
function setup(t, { start = '1000', registered = { pid: 42, sessionId: 'abc', procStart: '1000' } } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-close-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  if (registered) fs.writeFileSync(path.join(home, '.claude', 'sessions', registered.pid + '.json'), JSON.stringify(registered));
  const calls = [];
  const exec = (cmd, args, opts, cb) => { calls.push([cmd, ...args]); cb(null, cmd === 'powershell' ? start : ''); };
  return { calls, close: createClose({ home, platform: 'win32', exec }) };
}

test('encerra o processo registrado da sessão do Claude Code com os filhos', async (t) => {
  const { calls, close } = setup(t);
  const r = await close({ tool: 'Claude Code', id: 'abc' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.at(-1), ['taskkill', '/PID', '42', '/T', '/F']);
});

test('não mata um processo que herdou o PID da sessão', async (t) => {
  const { calls, close } = setup(t, { start: String(1000 + 5e7) });
  const r = await close({ tool: 'Claude Code', id: 'abc' });
  assert.equal(r.ok, false);
  assert.ok(!calls.some((c) => c[0] === 'taskkill'));
});

test('sessão sem processo aberto ou de ferramenta sem suporte não encerra nada', async (t) => {
  const { calls, close } = setup(t, { registered: null });
  assert.equal((await close({ tool: 'Claude Code', id: 'abc' })).ok, false);
  assert.equal((await close({ tool: 'Codex', id: 'x', where: 'vscode' })).ok, false);
  assert.equal(calls.length, 0);
});
