const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReplyQueue, replyKey } = require('../src/actions/replies');
const { createPermissions } = require('../src/actions/permissions');

test('a resposta enfileirada sobrevive ao reinício e é entregue uma única vez ao hook', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hud-replies-')), 'replies.json');
  const queue = createReplyQueue(file);
  queue.listen('sessao', 'claude');
  assert.ok(queue.listenState('sessao', Date.now()) > Date.now());
  queue.set('sessao', 'continue');
  const restarted = createReplyQueue(file);
  assert.equal(restarted.queued('sessao'), 'continue');
  assert.equal(restarted.take('sessao'), 'continue');
  assert.equal(restarted.take('sessao'), null);
  assert.equal(createReplyQueue(file).queued('sessao'), null);
  queue.set('outra', 'x');
  queue.set('outra', '');
  assert.equal(queue.queued('outra'), null, 'texto vazio cancela');
});

test('a chave da resposta do Codex é o uuid no fim do nome do rollout', () => {
  const id = 'rollout-2026-10-28T10-00-00-00000000-0000-4000-8000-000000000001';
  assert.equal(replyKey({ tool: 'Codex', id }), '00000000-0000-4000-8000-000000000001');
  assert.equal(replyKey({ tool: 'Claude Code', id: 'abc' }), 'abc');
});

test('modo remoto: segura o pedido até a decisão e devolve ao PC ao desligar', () => {
  const changes = [];
  const perms = createPermissions({ onRemoteChange: (on) => changes.push(on) });
  assert.equal(perms.open('s1', 'Bash', 'ls'), null, 'fora do modo remoto o pedido fica no PC');
  perms.setRemote(true);
  const id = perms.open('s1', 'Bash', 'ls');
  assert.equal(perms.pendingFor('s1', Date.now()).summary, 'ls');
  assert.equal(perms.decide(id, 'talvez'), 'invalid');
  assert.equal(perms.decide(id, 'allow'), 'ok');
  assert.equal(perms.decide(id, 'deny'), 'gone');
  assert.deepEqual(perms.poll(id), { decision: 'allow' });
  assert.deepEqual(perms.poll(id), { gone: true });
  const waiting = perms.open('s2', 'Edit', 'a.js');
  perms.setRemote(false);
  assert.deepEqual(perms.poll(waiting), { gone: true });
  assert.deepEqual(changes, [true, false]);
});
