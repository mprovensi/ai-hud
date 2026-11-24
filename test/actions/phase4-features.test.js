const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const {
  generateVapidKeys,
  buildVapidAuthHeader,
  encryptWebPushPayload,
  decryptWebPushPayload,
  b64uEncode,
  b64uDecode,
} = require('../../src/core/webpush');
const { createPush } = require('../../src/actions/push');
const { createWorkspaceSync, parsePorcelain } = require('../../src/actions/workspace/sync');
const { handleRpc } = require('../../integrations/mcp/memory-server');
const { createApp } = require('../../src/main');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function reqJson(port, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        ...(token ? { Cookie: `hud=${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, text: data, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('webpush crypto: VAPID JWT ES256 válido e criptografia RFC 8291 (aes128gcm) ponta a ponta', () => {
  const vapid = generateVapidKeys();
  assert.equal(b64uDecode(vapid.publicKey).length, 65);
  assert.equal(b64uDecode(vapid.publicKey)[0], 0x04);

  const auth = buildVapidAuthHeader({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', vapid, nowSec: 1700000000 });
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
  assert.ok(m);
  assert.equal(m[2], vapid.publicKey);
  const [h, p, s] = m[1].split('.');
  const validSig = crypto.verify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key: vapid.publicKeyPem, dsaEncoding: 'ieee-p1363' },
    b64uDecode(s),
  );
  assert.equal(validSig, true);

  // Simula navegador (UA ECDH + auth secret 16B) e valida descriptografia exata
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const uaPubB64 = b64uEncode(ua.getPublicKey());
  const authB64 = b64uEncode(crypto.randomBytes(16));
  const payload = JSON.stringify({ title: 'AI HUD', body: 'Sessão pronta com acentuação: ação!', url: '/#s=1' });
  const encrypted = encryptWebPushPayload(payload, uaPubB64, authB64);
  const decrypted = decryptWebPushPayload(encrypted, ua, authB64);
  assert.equal(decrypted, payload);
});

test('createPush envia notificações, remove assinaturas 410 expiradas e dispara em transições do snapshot', async () => {
  const dataDir = tmpDir('hud-push-');
  const ua1 = crypto.createECDH('prime256v1'); ua1.generateKeys();
  const ua2 = crypto.createECDH('prime256v1'); ua2.generateKeys();
  const sentCalls = [];

  const push = createPush({
    dataDir,
    sendRequest: async (endpoint, headers, body) => {
      sentCalls.push({ endpoint, headers, body });
      if (endpoint.includes('gone')) return { status: 410 };
      return { status: 201 };
    },
  });

  assert.equal(push.subscribe({ endpoint: 'https://push.test/ok', keys: { p256dh: b64uEncode(ua1.getPublicKey()), auth: b64uEncode(crypto.randomBytes(16)) } }).status, 200);
  assert.equal(push.subscribe({ endpoint: 'https://push.test/gone', keys: { p256dh: b64uEncode(ua2.getPublicKey()), auth: b64uEncode(crypto.randomBytes(16)) } }).status, 200);
  assert.equal(push.publicInfo().count, 2);

  const res = await push.notifyAll({ title: 'Teste', body: 'Oi' });
  assert.equal(res.sent, 1);
  assert.equal(res.pruned, 1);
  assert.equal(push.publicInfo().count, 1);

  // Transições de snapshot: 1º snapshot apenas inicializa (sem spam), 2º dispara permissão e fim de turno
  sentCalls.length = 0;
  push.observeSnapshot({ active: [{ id: 's1', tool: 'Claude Code', project: 'App', state: 'working', lastReplyAt: 100 }] });
  assert.equal(sentCalls.length, 0);

  push.observeSnapshot({
    active: [
      { id: 's1', tool: 'Claude Code', project: 'App', state: 'waiting', lastReplyAt: 200, lastReply: 'Concluído!' },
      { id: 's2', tool: 'Codex', project: 'API', state: 'permission', permission: { id: 'p1', tool: 'Bash' } },
    ],
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sentCalls.length, 2);
});

test('MCP memory-server: initialize, tools/list, memory_search, memory_read com contenção e workspace_list', () => {
  const ws = tmpDir('hud-mcp-');
  fs.mkdirSync(path.join(ws, 'memory', 'ai-hud', 'episodic'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({
    entities: [{ id: 'e1', title: 'AI HUD', pinned: true, projectBindings: [{ machine: 'Note', cwd: 'D:/Projetos/ai-hud' }] }],
  }));
  fs.writeFileSync(path.join(ws, 'memory', 'ai-hud', 'decisions.md'), '# Decisões\nUsar WebAuthn e VAPID zero-deps.\n');

  const init = handleRpc({ id: 1, method: 'initialize' }, ws);
  assert.equal(init.result.serverInfo.name, 'ai-hud-memory');

  const tools = handleRpc({ id: 2, method: 'tools/list' }, ws);
  assert.deepEqual(tools.result.tools.map((t) => t.name), [
    'memory_search',
    'memory_read',
    'workspace_list',
    'board_read',
    'board_update_status',
    'board_add_item',
  ]);

  const search = handleRpc({ id: 3, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'VAPID' } } }, ws);
  const parsed = JSON.parse(search.result.content[0].text);
  assert.equal(parsed.total, 1);
  assert.match(parsed.results[0].file, /decisions\.md$/);

  const readOk = handleRpc({ id: 4, method: 'tools/call', params: { name: 'memory_read', arguments: { project: 'ai-hud', file: 'decisions.md' } } }, ws);
  assert.equal(readOk.result.isError, false);
  assert.match(readOk.result.content[0].text, /VAPID/);

  // Bloqueia traversal
  const readBad = handleRpc({ id: 5, method: 'tools/call', params: { name: 'memory_read', arguments: { project: 'ai-hud', file: '../../workspace.json' } } }, ws);
  assert.equal(readBad.result.isError, true);

  const list = handleRpc({ id: 6, method: 'tools/call', params: { name: 'workspace_list', arguments: {} } }, ws);
  const listData = JSON.parse(list.result.content[0].text);
  assert.deepEqual(listData.memoryProjects, ['ai-hud']);
  assert.equal(listData.entities.length, 1);
});

test('workspaceSync: parsePorcelain e ciclo completo init + commit + push para remoto bare', async () => {
  const p = parsePorcelain('## main...origin/main [ahead 2, behind 1]\n M notes.md\nUU conflict.md\n');
  assert.equal(p.branch, 'main');
  assert.equal(p.ahead, 2);
  assert.equal(p.behind, 1);
  assert.equal(p.dirty, 2);
  assert.deepEqual(p.conflicts, ['conflict.md']);

  const dataDir = tmpDir('hud-sync-data-');
  const wsDir = path.join(dataDir, 'workspace');
  const bareDir = tmpDir('hud-sync-bare-');
  execFileSync('git', ['init', '--bare', bareDir], { stdio: 'ignore' });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'notes.md'), '# Nota inicial\n');

  const syncer = createWorkspaceSync({ dataDir, config: { workspaceRoot: wsDir } });
  const before = await syncer.status();
  assert.equal(before.isRepo, false);

  // Inicializa sem remoto primeiro para configurar user local do git no repo de teste
  const rInit = await syncer.sync({ init: true });
  assert.equal(rInit.status, 200);
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: wsDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wsDir });

  fs.writeFileSync(path.join(wsDir, 'notes.md'), '# Nota atualizada\n');
  const rPush = await syncer.sync({ remote: bareDir, message: 'sync teste' });
  assert.equal(rPush.status, 200);
  assert.equal(rPush.body.committed, true);
  assert.equal(rPush.body.pushed, true);
  assert.equal(rPush.body.status.dirty, 0);
  assert.equal(rPush.body.status.remote, bareDir);
});

test('Fase 4 end-to-end: rotas /api/workspace/sync e /api/push/* no servidor HTTP', async () => {
  const dataDir = tmpDir('hud-p4-data-');
  const token = '11223344aabbccdd55667788';
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ token, pin: '12345678', name: 'TestP4' }));

  const app = createApp({
    dataDir,
    sources: { all: () => [] },
    quotaFetchers: {},
    brands: false,
    log: () => {},
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address();
  try {
    const syncSt = await reqJson(port, 'GET', '/api/workspace/sync', token);
    assert.equal(syncSt.status, 200);
    assert.equal(syncSt.json.ok, true);
    assert.equal(syncSt.json.isRepo, false);

    const pk = await reqJson(port, 'GET', '/api/push/public-key', token);
    assert.equal(pk.status, 200);
    assert.equal(pk.json.enabled, true);
    assert.ok(pk.json.publicKey.length >= 80);

    const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
    const sub = await reqJson(port, 'POST', '/api/push/subscribe', token, {
      endpoint: 'https://push.example/sub1',
      keys: { p256dh: b64uEncode(ua.getPublicKey()), auth: b64uEncode(crypto.randomBytes(16)) },
    });
    assert.equal(sub.status, 200);
    assert.equal(sub.json.count, 1);

    const unsub = await reqJson(port, 'POST', '/api/push/unsubscribe', token, { endpoint: 'https://push.example/sub1' });
    assert.equal(unsub.status, 200);
    assert.equal(unsub.json.count, 0);
  } finally {
    app.server.close();
  }
});
