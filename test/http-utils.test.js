const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { authorized, readJson, handleRequest } = require('../src/http-utils');

const TOKEN = 'a'.repeat(24);

function request(server, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route,
      method: body === undefined ? 'GET' : 'POST', headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('HTTP rejects invalid authentication and bodies while remaining available', async (t) => {
  let actions = 0;
  const server = http.createServer(handleRequest((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!authorized(req, url, TOKEN)) { res.writeHead(401); return res.end(); }
    if (url.pathname === '/sync-error') throw new Error('internal secret');
    if (url.pathname === '/async-error') return Promise.reject(new Error('internal secret'));
    if (req.method === 'POST') return readJson(req).then((body) => {
      actions++;
      res.end(JSON.stringify(body));
    });
    res.end('ok');
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  for (const token of ['', 'b'.repeat(24), 'é'.repeat(24), '😀'.repeat(12)]) {
    assert.equal((await request(server, '/?t=' + encodeURIComponent(token))).status, 401);
  }
  assert.equal((await request(server, '/?t=' + TOKEN)).text, 'ok');
  assert.equal((await request(server, '/', undefined, { Cookie: 'other=x; hud=' + TOKEN })).text, 'ok');
  for (const body of ['null', '[]', 'true', '42', '"texto"', '{', '']) {
    assert.equal((await request(server, '/?t=' + TOKEN, body)).status, 400);
  }
  assert.equal((await request(server, '/?t=' + TOKEN, JSON.stringify({ text: 'a'.repeat(20000) }))).status, 413);
  assert.equal(actions, 0, 'invalid bodies must not trigger actions');
  const limit = JSON.stringify({ text: 'a'.repeat(19989) });
  assert.equal(Buffer.byteLength(limit), 20000);
  assert.equal((await request(server, '/?t=' + TOKEN, limit)).status, 200);
  const valid = await request(server, '/?t=' + TOKEN, JSON.stringify({ text: 'olá 👋' }));
  assert.deepEqual(JSON.parse(valid.text), { text: 'olá 👋' });
  for (const route of ['/sync-error', '/async-error']) {
    const result = await request(server, route + '?t=' + TOKEN);
    assert.equal(result.status, 500);
    assert.equal(result.text, 'erro interno do servidor');
  }
  assert.equal((await request(server, '/?t=' + TOKEN)).status, 200);
});

test('readJson joins split UTF-8 bytes and rejects aborted requests', async () => {
  const req = new EventEmitter();
  const result = readJson(req);
  const bytes = Buffer.from('{"text":"á"}');
  const split = bytes.indexOf(Buffer.from('á')) + 1;
  req.emit('data', bytes.subarray(0, split));
  req.emit('data', bytes.subarray(split));
  req.emit('end');
  assert.deepEqual(await result, { text: 'á' });
  const aborted = new EventEmitter();
  const rejected = assert.rejects(readJson(aborted), { statusCode: 400 });
  aborted.emit('aborted');
  await rejected;
});
