const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createClose } = require('../../src/actions/close');
const { createRunning } = require('../../src/actions/running');
const EventEmitter = require('node:events');

// Home falsa com o registro de processo da sessão; exec falso responde a hora de início e grava os comandos
function setup(t, { start = '1000', registered = { pid: 42, sessionId: 'abc', procStart: '1000' }, running = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-close-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  if (registered) fs.writeFileSync(path.join(home, '.claude', 'sessions', registered.pid + '.json'), JSON.stringify(registered));
  const calls = [];
  const exec = (cmd, args, opts, cb) => { calls.push([cmd, ...args]); cb(null, cmd === 'powershell' ? start : ''); };
  return { calls, close: createClose({ home, platform: 'win32', exec, running }) };
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

test('Codex, Gemini e Claude sem processo aberto encerram/arquivam no HUD sem matar processos aleatórios', async (t) => {
  const { calls, close } = setup(t, { registered: null });
  const claudeWorking = await close({ tool: 'Claude Code', id: 'abc', state: 'working' });
  assert.equal(claudeWorking.ok, false);
  const claudeIdle = await close({ tool: 'Claude Code', id: 'abc', state: 'waiting' });
  assert.equal(claudeIdle.ok, true);
  assert.ok(close.endedAt('abc') > 0);
  const codex = await close({ tool: 'Codex', id: 'x', where: 'vscode' });
  assert.equal(codex.ok, true);
  assert.ok(close.endedAt('x') > 0);
  const gemini = await close({ tool: 'Gemini', id: 'g1', where: 'antigravity-cli' });
  assert.equal(gemini.ok, true);
  assert.ok(close.endedAt('g1') > 0);
  assert.equal(calls.length, 0);
});

test('sessão iniciada pelo HUD (running) tem seu processo finalizado ao encerrar', async (t) => {
  const running = createRunning();
  const child = new EventEmitter();
  child.pid = 777;
  running.track('00000000-0000-4000-8000-000000000077', child);
  const { calls, close } = setup(t, { registered: null, running });
  const r = await close({ tool: 'Gemini', id: '00000000-0000-4000-8000-000000000077', where: 'antigravity-cli' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.at(-1), ['taskkill', '/PID', '777', '/T', '/F']);
  assert.equal(running.isBusy('00000000-0000-4000-8000-000000000077'), false);
});
