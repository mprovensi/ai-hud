const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPendingStore } = require('../../src/actions/pending');
const { createReplyQueue, replyKey } = require('../../src/actions/reply/claude-queue');
const { createPermissions } = require('../../src/actions/permissions');

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hud-pending-')), 'pending.json');

test('a resposta enfileirada sobrevive ao reinício e é entregue uma única vez ao hook', () => {
  const file = tempFile();
  const queue = createReplyQueue(createPendingStore(file));
  queue.listen('sessao', 'claude');
  assert.ok(queue.listenState('sessao', Date.now()) > Date.now());
  queue.set('sessao', 'continue');
  const restarted = createReplyQueue(createPendingStore(file));
  assert.equal(restarted.queued('sessao'), 'continue');
  assert.ok(restarted.listenState('sessao', Date.now()), 'o hook que estava escutando continua valendo após o reinício');
  assert.equal(restarted.take('sessao'), 'continue');
  assert.equal(restarted.take('sessao'), null);
  assert.equal(createReplyQueue(createPendingStore(file)).queued('sessao'), null);
  queue.set('outra', 'x');
  queue.set('outra', '');
  assert.equal(queue.queued('outra'), null, 'texto vazio cancela');
});

test('a fila de respostas de instalações anteriores (replies.json) é importada', () => {
  const file = tempFile();
  fs.writeFileSync(path.join(path.dirname(file), 'replies.json'), JSON.stringify({ antiga: { text: 'Continue', at: 1 } }));
  assert.equal(createReplyQueue(createPendingStore(file)).queued('antiga'), 'Continue');
});

test('a chave da resposta do Codex é o uuid no fim do nome do rollout', () => {
  const id = 'rollout-2026-10-28T10-00-00-00000000-0000-4000-8000-000000000001';
  assert.equal(replyKey({ tool: 'Codex', id }), '00000000-0000-4000-8000-000000000001');
  assert.equal(replyKey({ tool: 'Claude Code', id: 'abc' }), 'abc');
});

test('modo remoto: segura o pedido até a decisão e devolve ao PC ao desligar', () => {
  const changes = [];
  const perms = createPermissions({ store: createPendingStore(tempFile()), onRemoteChange: (on) => changes.push(on) });
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

test('um pedido de permissão em espera sobrevive ao reinício do servidor', () => {
  const file = tempFile();
  const before = createPermissions({ store: createPendingStore(file), remoteMode: true });
  const id = before.open('s1', 'Bash', 'rm -rf build');
  const after = createPermissions({ store: createPendingStore(file), remoteMode: true });
  assert.equal(after.pendingFor('s1', Date.now()).id, id);
  assert.equal(after.decide(id, 'deny'), 'ok');
  assert.deepEqual(after.poll(id), { decision: 'deny' });
});
