const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { createReplies } = require('../../src/actions/reply');
const { focusPlan } = require('../../src/actions/focus/plan');

test('createReplies envia resposta ao Gemini via agy --conversation <uuid> --print=<texto>', async () => {
  const calls = [];
  const spawn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = () => { child.unreffed = true; };
    calls.push({ exe, args, opts, child });
    return child;
  };
  const reply = createReplies({
    queue: { set() {}, listenState: () => null },
    agyExe: 'agy.exe',
    spawn,
    findSession: () => ({ tool: 'Gemini', id: '00000000-0000-4000-8000-000000000001', cwd: 'D:\\Projetos\\ai-hud' }),
  });

  const bad = await reply({ key: 'sem-id-2026-05-20', text: 'oi', tool: 'Gemini' });
  assert.equal(bad.status, 400);

  const ok = await reply({ key: '00000000-0000-4000-8000-000000000001', text: 'continue', tool: 'Gemini' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { sent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, 'agy.exe');
  assert.deepEqual(calls[0].args, ['--conversation', '00000000-0000-4000-8000-000000000001', '--print=continue', '--output-format', 'json']);
  assert.equal(calls[0].opts.cwd, 'D:\\Projetos\\ai-hud');
  assert.equal(calls[0].child.unreffed, true);
});

test('focusPlan gera plano de janela do Antigravity com fallback antigravity://', () => {
  const plan = focusPlan({ tool: 'Gemini', id: '00000000-0000-4000-8000-000000000001', where: 'antigravity', cwd: 'D:\\Projetos\\ai-hud' });
  assert.equal(plan.process, 'Antigravity');
  assert.equal(plan.include, 'ai-hud|Antigravity');
  assert.equal(plan.fallbackUri, 'antigravity://');
});
