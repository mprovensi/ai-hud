const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { createReplies } = require('../../src/actions/reply');
const { createRunning } = require('../../src/actions/running');
const { focusPlan } = require('../../src/actions/focus/plan');

test('createReplies envia resposta ao Gemini CLI via agy, registra erro tardio e bloqueia sessao da IDE Antigravity', async () => {
  const calls = [];
  const spawn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = () => { child.unreffed = true; };
    calls.push({ exe, args, opts, child });
    return child;
  };
  const running = createRunning();
  let currentWhere = 'antigravity-cli';
  const reply = createReplies({
    queue: { set() {}, listenState: () => null },
    agyExe: 'agy.exe',
    spawn,
    running,
    findSession: () => ({ tool: 'Gemini', id: '00000000-0000-4000-8000-000000000001', where: currentWhere, cwd: 'D:\\Projetos\\ai-hud' }),
  });

  const bad = await reply({ key: 'sem-id-2026-05-20', text: 'oi', tool: 'Gemini' });
  assert.equal(bad.status, 400);

  // Sessão da IDE Antigravity retorna 409 claro em vez de falhar silenciosamente no agy
  currentWhere = 'antigravity';
  const ideBlocked = await reply({ key: '00000000-0000-4000-8000-000000000001', text: 'oi', tool: 'Gemini' });
  assert.equal(ideBlocked.status, 409);
  assert.match(ideBlocked.body, /Antigravity \(IDE\)/);
  assert.equal(calls.length, 0);

  // Sessão do Antigravity CLI (`agy`) entrega normalmente e registra erro tardio se falhar depois
  currentWhere = 'antigravity-cli';
  const ok = await reply({ key: '00000000-0000-4000-8000-000000000001', text: 'continue', tool: 'Gemini' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { sent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, 'agy.exe');
  assert.deepEqual(calls[0].args, ['--conversation', '00000000-0000-4000-8000-000000000001', '--print=continue', '--dangerously-skip-permissions', '--output-format', 'json']);
  assert.equal(calls[0].opts.cwd, 'D:\\Projetos\\ai-hud');
  assert.equal(calls[0].child.unreffed, true);

  calls[0].child.stderr.emit('data', 'trajectory not found\n');
  calls[0].child.emit('exit', 1);
  assert.equal(running.lastError('00000000-0000-4000-8000-000000000001'), 'trajectory not found');
});

test('focusPlan gera plano de janela do Antigravity com fallback antigravity://', () => {
  const plan = focusPlan({ tool: 'Gemini', id: '00000000-0000-4000-8000-000000000001', where: 'antigravity', cwd: 'D:\\Projetos\\ai-hud' });
  assert.equal(plan.process, 'Antigravity');
  assert.equal(plan.include, 'ai-hud|Antigravity');
  assert.equal(plan.fallbackUri, 'antigravity://');
});
