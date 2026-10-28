const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '../ollama-chats.js'), 'utf8');

function load(store, chats) {
  let disk = JSON.stringify(store), writes = 0;
  const requests = [];
  const sandbox = { module: { exports: {} }, __dirname, process, Buffer, URL, setInterval: () => {},
    require: (name) => {
      if (name === 'fs') return { readFileSync: () => disk, writeFileSync: (file, data) => { disk = data; writes++; }, statSync: () => ({ mtimeMs: 1, size: 1 }) };
      if (name === 'node:sqlite') {
        if (!chats) throw new Error('sqlite disabled in test');
        return { DatabaseSync: class {
          prepare(sql) { return { all: () => sql.includes('FROM chats') ? chats : [] }; }
          close() {}
        } };
      }
      if (name === './ollama-metrics') return require('../ollama-metrics');
      if (name === 'child_process') return { execFile: () => {} };
      if (name === 'http') return { request: (url, options, respond) => {
        const req = new EventEmitter();
        req.end = () => {};
        req.respond = (body) => {
          const res = new EventEmitter();
          respond(res);
          res.emit('data', Buffer.from(JSON.stringify(body)));
          res.emit('end');
        };
        requests.push(req);
        return req;
      } };
      return require(name);
    } };
  vm.runInNewContext(source, sandbox);
  return { api: sandbox.module.exports, requests, state: () => JSON.parse(disk), writes: () => writes };
}

test('restart releases interrupted generations, preserves messages and allows another reply', async () => {
  const message = { role: 'user', content: 'pedido original', at: 1 };
  const loaded = load({ interrupted: { generating: true, messages: [message] }, ready: { generating: false, messages: [] } });
  const restored = loaded.state();
  assert.equal(restored.interrupted.generating, false);
  assert.deepEqual(restored.interrupted.messages[0], message);
  assert.match(restored.interrupted.messages[1].content, /interrompida/);
  assert.equal(restored.ready.messages.length, 0);
  assert.equal(loaded.writes(), 1);
  const again = load(restored);
  assert.equal(again.writes(), 0, 'recovery must not repeat on the next restart');
  const session = { chatId: 'interrupted', models: new Set(['test-model']), history: restored.interrupted.messages };
  assert.equal((await loaded.api.replyToChat(session, 'continue', 'http://localhost:11434')).sent, true);
  await assert.rejects(loaded.api.replyToChat(session, 'duplicate', 'http://localhost:11434'), /ainda gerando/);
  loaded.requests[0].respond({ message: { content: 'resposta' } });
  assert.equal(loaded.state().interrupted.generating, false);
  assert.equal(loaded.state().interrupted.messages.at(-1).content, 'resposta');
});

test('normal startup leaves completed conversations unchanged', () => {
  const store = { ready: { generating: false, messages: [{ role: 'assistant', content: 'ok' }] } };
  const loaded = load(store);
  assert.deepEqual(loaded.state(), store);
  assert.equal(loaded.writes(), 0);
});

test('recovery tolerates an invalid persisted root or interrupted entry', () => {
  assert.doesNotThrow(() => load(null));
  const loaded = load({ invalid: null, interrupted: { generating: true } });
  assert.equal(loaded.state().interrupted.generating, false);
  assert.equal(loaded.state().interrupted.messages.length, 1);
});

test('reply saves measured generation speed and exposes it with the last response', async () => {
  const chats = [{ id: 'test', title: 'Teste', created_at: 1793181600 }];
  const loaded = load({}, chats);
  const session = { chatId: 'test', models: new Set(['test-model']), history: [] };
  await loaded.api.replyToChat(session, 'pergunta', 'http://localhost:11434');
  loaded.requests[0].respond({ message: { content: 'resposta medida' }, prompt_eval_count: 30,
    eval_count: 100, eval_duration: 2e9, total_duration: 3e9 });
  const stored = loaded.state().test.messages.at(-1);
  assert.equal(stored.metrics.tokensPerSecond, 50);
  const restored = load(loaded.state(), chats).api.ollamaChatSessions()[0];
  assert.equal(restored.lastReply, 'resposta medida');
  assert.equal(restored.generation.tokensPerSecond, 50);
  assert.equal(restored.generation.outputTokens, 100);
});
