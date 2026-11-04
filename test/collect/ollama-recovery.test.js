const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createOllamaSource } = require('../../src/collect/sources/ollama');

// Pasta temporária com o ollama-replies.json (gravado com recuo: se o HUD regravar, o texto muda)
// e, opcionalmente, o banco do app do Ollama com as conversas
function load(store, chats, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-replies-'))) {
  const file = path.join(dir, 'ollama-replies.json');
  if (store !== undefined) fs.writeFileSync(file, JSON.stringify(store, null, 2));
  const original = store === undefined ? null : fs.readFileSync(file, 'utf8');
  const appDb = path.join(dir, 'db.sqlite');
  if (chats && !fs.existsSync(appDb)) {
    const db = new DatabaseSync(appDb);
    db.exec(`CREATE TABLE chats (id TEXT, title TEXT, created_at TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, chat_id TEXT, role TEXT, content TEXT, model_name TEXT, created_at TEXT, updated_at TEXT);`);
    for (const c of chats) db.prepare('INSERT INTO chats VALUES (?, ?, ?)').run(c.id, c.title, String(c.created_at));
    db.close();
  }
  const requests = [];
  const request = (url, options, respond) => {
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
  };
  const api = createOllamaSource({ dataDir: dir, appDb, proxyDb: path.join(dir, 'nenhum.sqlite'), historyFile: path.join(dir, 'history'),
    scanner: { runs: () => [], start() {} }, request });
  return { api, requests, dir, state: () => JSON.parse(fs.readFileSync(file, 'utf8')), rewritten: () => fs.readFileSync(file, 'utf8') !== original };
}

test('restart releases interrupted generations, preserves messages and allows another reply', async () => {
  const message = { role: 'user', content: 'pedido original', at: 1 };
  const loaded = load({ interrupted: { generating: true, messages: [message] }, ready: { generating: false, messages: [] } });
  const restored = loaded.state();
  assert.equal(restored.interrupted.generating, false);
  assert.deepEqual(restored.interrupted.messages[0], message);
  assert.match(restored.interrupted.messages[1].content, /interrompida/);
  assert.equal(restored.ready.messages.length, 0);
  assert.equal(loaded.rewritten(), true);
  const again = load(restored);
  assert.equal(again.rewritten(), false, 'recovery must not repeat on the next restart');
  const session = { chatId: 'interrupted', models: new Set(['test-model']), history: restored.interrupted.messages };
  assert.equal((await loaded.api.reply(session, 'continue', 'http://localhost:11434')).sent, true);
  await assert.rejects(loaded.api.reply(session, 'duplicate', 'http://localhost:11434'), /ainda gerando/);
  loaded.requests[0].respond({ message: { content: 'resposta' } });
  assert.equal(loaded.state().interrupted.generating, false);
  assert.equal(loaded.state().interrupted.messages.at(-1).content, 'resposta');
});

test('normal startup leaves completed conversations unchanged', () => {
  const store = { ready: { generating: false, messages: [{ role: 'assistant', content: 'ok' }] } };
  const loaded = load(store);
  assert.deepEqual(loaded.state(), store);
  assert.equal(loaded.rewritten(), false);
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
  await loaded.api.reply(session, 'pergunta', 'http://localhost:11434');
  loaded.requests[0].respond({ message: { content: 'resposta medida' }, prompt_eval_count: 30,
    eval_count: 100, eval_duration: 2e9, total_duration: 3e9 });
  const stored = loaded.state().test.messages.at(-1);
  assert.equal(stored.metrics.tokensPerSecond, 50);
  const restored = load(undefined, chats, loaded.dir).api.chatSessions()[0];
  assert.equal(restored.lastReply, 'resposta medida');
  assert.equal(restored.generation.tokensPerSecond, 50);
  assert.equal(restored.generation.outputTokens, 100);
});
