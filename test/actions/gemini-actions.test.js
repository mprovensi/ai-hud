const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { createReplies } = require('../../src/actions/reply');
const { createReplyQueue } = require('../../src/actions/reply/claude-queue');
const { createPendingStore } = require('../../src/actions/pending');
const { createRunning } = require('../../src/actions/running');
const { focusPlan } = require('../../src/actions/focus/plan');
const { isCliExecution } = require('../../integrations/antigravity/hook-stop');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('createReplies envia Gemini CLI via agy, enfileira IDE Antigravity no hook Stop e registra erro tardio', async () => {
  const calls = [];
  const spawn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = () => { child.unreffed = true; };
    calls.push({ exe, args, opts, child });
    return child;
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-agy-hook-'));
  const queue = createReplyQueue(createPendingStore(path.join(tmp, 'pending.json')));
  const running = createRunning();
  let currentWhere = 'antigravity-cli';
  const reply = createReplies({
    queue,
    agyExe: 'agy.exe',
    spawn,
    running,
    findSession: () => ({ tool: 'Gemini', id: '00000000-0000-4000-8000-000000000001', where: currentWhere, cwd: 'D:\\Projetos\\ai-hud' }),
  });

  const bad = await reply({ key: 'sem-id-2026-05-20', text: 'oi', tool: 'Gemini' });
  assert.equal(bad.status, 400);

  // Sessão da IDE Antigravity usa a fila do hook Stop (como Claude Code)
  currentWhere = 'antigravity';
  queue.listen('00000000-0000-4000-8000-000000000001', 'Gemini', Date.now() + 60e3);
  const ideQueued = await reply({ key: '00000000-0000-4000-8000-000000000001', text: 'siga para a fase 2', tool: 'Gemini' });
  assert.equal(ideQueued.status, 200);
  assert.equal(ideQueued.body.queued, 'siga para a fase 2');
  assert.ok(ideQueued.body.listening > Date.now());
  assert.equal(calls.length, 0);
  assert.equal(queue.take('00000000-0000-4000-8000-000000000001'), 'siga para a fase 2');

  // Helper do hook identifica corretamente execuções do agy CLI (para não travar --print)
  assert.equal(isCliExecution({ transcriptPath: 'C:\\Users\\u\\.gemini\\antigravity-cli\\brain\\x\\transcript.jsonl' }), true);
  assert.equal(isCliExecution({ transcriptPath: 'C:\\Users\\u\\.gemini\\antigravity\\brain\\x\\transcript.jsonl' }), false);

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
