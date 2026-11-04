const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../../src/main');

function setup(t) {
  const token = 'b'.repeat(24);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-longpoll-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ token, pin: '12345678' }));
  const sessions = [];
  const app = createApp({
    dataDir,
    sources: { all: () => sessions, ollamaReply: async () => ({ sent: true }) },
    quotaFetchers: { claude: async () => ({ windows: {} }), codex: async () => ({ windows: {} }) },
    focus: async () => ({ ok: true }),
    brands: false,
    log: () => {},
  });
  const get = (route) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: app.server.address().port, path: `${route}${route.includes('?') ? '&' : '?'}t=${token}`, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    }).on('error', reject);
  });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  return new Promise((resolve) => app.server.listen(0, '127.0.0.1', () => resolve({ app, sessions, get })));
}

const session = (id) => {
  const now = Date.now();
  return { id, tool: 'Claude Code', cwd: '/p', start: new Date(now - 1000).toISOString(), end: new Date(now).toISOString(), mtime: now,
    lastStop: 'end_turn', models: new Set(), tools: {}, events: [], input: 0, output: 0, cacheRead: 0, cacheWrite: 0, prompts: 1, lastReply: 'ok' };
};

test('?desde= segura a resposta até o snapshot mudar e devolve a versão nova', async (t) => {
  const { app, sessions, get } = await setup(t);
  const first = await get('/api/snapshot');
  assert.equal(first.status, 200);
  assert.ok(first.json.version, 'o snapshot informa a versão');
  const started = Date.now();
  const waiting = get(`/api/snapshot?desde=${encodeURIComponent(first.json.version)}&espera=10`);
  await new Promise((r) => setTimeout(r, 150));
  sessions.push(session('nova'));
  app.collector.poke();
  const changed = await waiting;
  assert.ok(Date.now() - started < 3000, 'responde assim que muda, sem esperar o prazo');
  assert.notEqual(changed.json.version, first.json.version);
  assert.equal(changed.json.active[0].id, 'nova');
});

test('sem mudança, responde no fim da espera com a mesma versão; versão desconhecida responde na hora', async (t) => {
  const { get } = await setup(t);
  const first = await get('/api/snapshot');
  let started = Date.now();
  const same = await get(`/api/snapshot?desde=${encodeURIComponent(first.json.version)}&espera=1`);
  assert.ok(Date.now() - started >= 900, 'esperou o prazo pedido');
  assert.equal(same.json.version, first.json.version);
  started = Date.now();
  await get('/api/snapshot?desde=processo-anterior-7&espera=10');
  assert.ok(Date.now() - started < 1000, 'versão de outro processo do servidor: responde na hora');
});
