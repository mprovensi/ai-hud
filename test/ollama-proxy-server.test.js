const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createProxy, openStore, summarizeRequest, summarizeResponse, sessionId } = require('../ollama-proxy/proxy');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

function post(port, route, body, onResponse) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'User-Agent': 'ollama/0.40 (teste)' } }, (res) => {
      if (onResponse) return onResponse(req, res, resolve);
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', (e) => (onResponse ? resolve(null) : reject(e)));
    req.end(data);
  });
}

async function waitRows(db, n) {
  for (let i = 0; i < 50; i++) {
    const rows = db.prepare('SELECT * FROM calls ORDER BY id').all();
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('nada gravado');
}

test('o proxy repassa o streaming do Ollama ao cliente e grava pergunta, resposta e tokens', async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/api/tags') return res.end('{"models":[]}');
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'Olá' } }) + '\n');
    setTimeout(() => res.end(JSON.stringify({ message: { content: ', mundo' }, done: true, prompt_eval_count: 12, eval_count: 3 }) + '\n'), 10);
  });
  const upPort = await listen(upstream);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-proxy-server-'));
  const file = path.join(dir, 'conversas.sqlite');
  const store = openStore(file);
  const proxy = createProxy({ upstream: { host: '127.0.0.1', port: upPort }, store });
  const port = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); store.close(); });

  const tags = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/tags', agent: false }, (res) => {
    let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve(text));
  }));
  assert.equal(tags, '{"models":[]}', 'o que não é inferência só é repassado');

  const body = { model: 'qwen3', messages: [{ role: 'system', content: 'seja breve' }, { role: 'user', content: 'oi' }] };
  const r = await post(port, '/api/chat', body);
  assert.equal(r.status, 200);
  assert.equal(r.text.trim().split('\n').length, 2, 'o cliente recebe os dois pedaços do streaming');

  const db = new DatabaseSync(file, { readOnly: true });
  const [row] = await waitRows(db, 1);
  db.close();
  assert.equal(row.endpoint, '/api/chat');
  assert.equal(row.model, 'qwen3');
  assert.equal(row.client_ip, '127.0.0.1');
  assert.equal(row.user_agent, 'ollama/0.40 (teste)');
  assert.equal(row.last_user, 'oi');
  assert.equal(row.message_count, 2);
  assert.equal(row.response_text, 'Olá, mundo');
  assert.equal(row.prompt_tokens, 12);
  assert.equal(row.completion_tokens, 3);
  assert.equal(row.client_aborted, 0);
  assert.match(row.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}$/);
  assert.equal(row.session_id, sessionId('127.0.0.1', 'qwen3', 'oi'));
});

test('cliente que desiste no meio interrompe o Ollama e a chamada fica marcada', async (t) => {
  let upstreamClosed = false;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ response: 'parcial' }) + '\n');
    res.on('close', () => { upstreamClosed = true; });
  });
  const upPort = await listen(upstream);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hud-proxy-abort-')), 'conversas.sqlite');
  const store = openStore(file);
  const proxy = createProxy({ upstream: { host: '127.0.0.1', port: upPort }, store });
  const port = await listen(proxy);
  t.after(async () => { await close(proxy); upstream.closeAllConnections(); await close(upstream); store.close(); });

  await post(port, '/api/generate', { model: 'qwen3', prompt: 'conte até mil' }, (req, res, resolve) => {
    res.once('data', () => { req.destroy(); resolve(); });
  });
  const db = new DatabaseSync(file, { readOnly: true });
  const [row] = await waitRows(db, 1);
  db.close();
  assert.equal(row.client_aborted, 1);
  assert.equal(row.response_text, 'parcial');
  assert.equal(row.last_user, 'conte até mil');
  assert.equal(upstreamClosed, true);
});

test('lê as APIs OpenAI e Anthropic em streaming e mantém a chave de sessão do proxy em Python', () => {
  const openai = Buffer.from([
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Oi' } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '!', tool_calls: [{ index: 0, function: { name: 'ler', arguments: '{"a":' } }] } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    'data: [DONE]',
  ].join('\n\n'));
  const o = summarizeResponse(openai);
  assert.equal(o.response_text, 'Oi!');
  assert.deepEqual(JSON.parse(o.tool_calls), [{ name: 'ler', arguments: '{"a":1}' }]);
  assert.equal(o.prompt_tokens, 5);
  const anthropic = Buffer.from([
    'event: message_start', 'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 9 } } }),
    'event: content_block_delta', 'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Olá' } }),
  ].join('\n'));
  const a = summarizeResponse(anthropic);
  assert.equal(a.response_text, 'Olá');
  assert.equal(a.prompt_tokens, 9);
  assert.deepEqual(summarizeRequest({ model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: 'x' }] }] }),
    { model: 'm', stream: null, count: 1, first: 'x', last: 'x' });
  // hashlib.sha1("192.168.5.2|None|oi".encode()).hexdigest()[:16] no proxy antigo
  assert.equal(sessionId('192.168.5.2', null, 'oi'), crypto.createHash('sha1').update('192.168.5.2|None|oi').digest('hex').slice(0, 16));
});
