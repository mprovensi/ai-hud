const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '../ollama-chats.js'), 'utf8');

function load(store) {
  let disk = JSON.stringify(store), writes = 0;
  const requests = [];
  const sandbox = { module: { exports: {} }, __dirname, process, Buffer, URL, setInterval: () => {},
    require: (name) => {
      if (name === 'fs') return { readFileSync: () => disk, writeFileSync: (file, data) => { disk = data; writes++; } };
      if (name === 'node:sqlite') throw new Error('sqlite disabled in test');
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
