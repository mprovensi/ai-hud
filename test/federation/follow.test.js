const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Peers } = require('../../src/federation/peers');
const { createApp } = require('../../src/main');

test('o hub segue o secundário com ?local=1 e long-polling quando informa versão, e a cada 10 s quando não', async (t) => {
  const urls = [];
  let reportVersion = true;
  const peer = http.createServer((req, res) => {
    urls.push(req.url.replace(/[?&]t=[^&]*/, ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...(reportVersion ? { version: `v${urls.length}` } : {}), active: [], recent: [], quotas: {}, today: {}, hours: [], days: [] }));
  });
  await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => peer.close(resolve)));
  const peers = new Peers([{ name: 'PC-Desktop', url: `http://127.0.0.1:${peer.address().port}`, token: 'x' }]);
  const p = peers.list[0];
  const scheduled = [];
  peers.schedule = (fn, ms) => scheduled.push(ms); // a próxima volta não roda sozinha no teste
  let updates = 0;

  await peers.follow(p, () => { updates++; });
  assert.equal(urls[0], '/api/snapshot?local=1', 'primeira consulta: ainda não sabe a versão e pede só dados locais');
  assert.equal(p.version, 'v1');
  await peers.follow(p, () => { updates++; });
  assert.equal(urls[1], '/api/snapshot?local=1&desde=v1&espera=25');
  assert.equal(updates, 2, 'cada snapshot recebido avisa o coletor');
  assert.deepEqual(scheduled, [0, 0], 'com versão, a próxima consulta sai na hora (quem espera é o secundário)');

  reportVersion = false; // secundário com versão antiga do HUD
  await peers.follow(p, () => {});
  assert.equal(p.version, null);
  await peers.follow(p, () => {});
  assert.equal(urls[3], '/api/snapshot?local=1');
  assert.deepEqual(scheduled.slice(2), [10e3, 10e3]);
});

test('multi-hub (?local=1) permite dois hubs se seguirem sem duplicar sessões (sem loop m0:m0:)', async (t) => {
  const makeDir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-multihub-'));
    t.after(() => fs.rmSync(d, { recursive: true, force: true }));
    return d;
  };
  const nowIso = new Date().toISOString();
  const fakeSession = (id) => ({
    tool: 'Claude Code', id, file: '', cwd: '/proj', start: nowIso, end: nowIso,
    input: 100, output: 50, cacheRead: 0, cacheWrite: 0, models: new Set(['claude']),
    subagent: false, context: 150, contextWindow: 200000, lastStop: 'end_turn',
    events: [{ ts: nowIso, fresh: 150, cacheRead: 0 }], title: id, prompts: 1,
    firstPrompt: id, lastPrompt: id, lastReply: 'ok', toolCalls: 0, lastTool: '', tools: {}, files: {}, history: [],
  });
  const emptyQuotas = { claude: async () => ({ plan: null, windows: {} }), codex: async () => ({ plan: null, windows: {} }), gemini: async () => ({ plan: null, windows: {} }) };

  const dirA = makeDir(), dirB = makeDir();
  fs.writeFileSync(path.join(dirA, 'config.json'), JSON.stringify({ name: 'VPS-Oracle', token: 'tokA', pin: '11111111', ollama: false }));
  fs.writeFileSync(path.join(dirB, 'config.json'), JSON.stringify({ name: 'Notebook', token: 'tokB', pin: '22222222', ollama: false }));

  // Inicia B primeiro para descobrir a porta e apontar A -> B; depois testa ?local=1 em A
  const appB = createApp({ dataDir: dirB, sources: { all: () => [fakeSession('sess-b')] }, quotaFetchers: emptyQuotas, brands: false, log: () => {} });
  await new Promise((r) => appB.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => appB.server.close(r)));
  const portB = appB.server.address().port;

  fs.writeFileSync(path.join(dirA, 'config.json'), JSON.stringify({
    name: 'VPS-Oracle', token: 'tokA', pin: '11111111', ollama: false,
    peers: [{ name: 'Notebook', url: `http://127.0.0.1:${portB}`, token: 'tokB' }],
  }));
  const appA = createApp({ dataDir: dirA, sources: { all: () => [fakeSession('sess-a')] }, quotaFetchers: emptyQuotas, brands: false, log: () => {} });
  await new Promise((r) => appA.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => appA.server.close(r)));
  const portA = appA.server.address().port;

  const getJson = (port, route) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${route}`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });

  // A busca B (via ?local=1), consolida as duas sessões
  const peersA = new Peers([{ name: 'Notebook', url: `http://127.0.0.1:${portB}`, token: 'tokB' }]);
  await peersA.pollAll();
  const localA = await getJson(portA, '/api/snapshot?local=1&t=tokA');
  assert.deepEqual(localA.active.map((s) => s.id), ['sess-a'], '?local=1 devolve apenas sessões locais');
  const mergedOnA = peersA.merge(localA, 'VPS-Oracle');
  assert.deepEqual(mergedOnA.active.map((s) => s.id).sort(), ['m0:sess-b', 'sess-a']);

  // B busca A via ?local=1: mesmo com A já tendo Notebook como peer, ?local=1 só devolve sess-a (sem m0:m0:)
  const peersB = new Peers([{ name: 'VPS-Oracle', url: `http://127.0.0.1:${portA}`, token: 'tokA' }]);
  await peersB.pollAll();
  const localB = await getJson(portB, '/api/snapshot?local=1&t=tokB');
  const mergedOnB = peersB.merge(localB, 'Notebook');
  assert.deepEqual(mergedOnB.active.map((s) => s.id).sort(), ['m0:sess-a', 'sess-b']);
});
