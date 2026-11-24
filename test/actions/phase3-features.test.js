const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { compareSessions } = require('../../src/core/session');
const { createSessionMeta } = require('../../src/actions/session-meta');
const { createUpload } = require('../../src/actions/upload');
const { collectSkills } = require('../../src/collect/skills');
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

test('compareSessions mantém permissão no topo e prioriza sessões fixadas (pinned)', () => {
  const list = [
    { id: 'w-unpinned', state: 'waiting', pinned: false, end: 500 },
    { id: 'a-unpinned', state: 'working', pinned: false, end: 400 },
    { id: 'w-pinned', state: 'waiting', pinned: true, end: 100 },
    { id: 'perm', state: 'permission', pinned: false, end: 50 },
    { id: 'a-pinned', state: 'working', pinned: true, end: 200 },
    { id: 'closed-pinned', state: 'closed', pinned: true, end: 900 },
  ];
  list.sort(compareSessions);
  assert.deepEqual(
    list.map((s) => s.id),
    ['perm', 'a-pinned', 'w-pinned', 'w-unpinned', 'a-unpinned', 'closed-pinned']
  );
});

test('createSessionMeta persiste pinned/alias/group em disco e limpa entradas vazias', () => {
  const dir = tmpDir('hud-smeta-');
  const m1 = createSessionMeta(dir);
  assert.equal(m1.set({ id: '' }).status, 400);

  const r1 = m1.set({ id: 'claude:abc', pinned: true, alias: '  API Core  ', group: 'Backend' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.meta.pinned, true);
  assert.equal(r1.body.meta.alias, 'API Core');
  assert.equal(r1.body.meta.group, 'Backend');

  // Recarrega do disco
  const m2 = createSessionMeta(dir);
  assert.equal(m2.get('claude:abc').alias, 'API Core');
  assert.equal(m2.get('claude:abc').pinned, true);

  // Limpa tudo -> entrada removida
  const r2 = m2.set({ id: 'claude:abc', pinned: false, alias: '', group: '' });
  assert.equal(r2.status, 200);
  assert.equal(m2.get('claude:abc'), null);
});

test('createUpload salva imagens válidas em inbox/attachments e rejeita extensões inválidas ou excessivas', () => {
  const dataDir = tmpDir('hud-up-data-');
  const wsRoot = tmpDir('hud-up-ws-');
  const upload = createUpload({ dataDir, config: { workspaceRoot: wsRoot }, now: () => Date.UTC(2026, 10, 23) });

  // PNG mínimo 1x1
  const pngB64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const ok = upload({ fileName: 'Tela Bug.png', base64Data: pngB64 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.match(ok.body.relPath, /^inbox\/attachments\/2026-11-23-tela-bug-[a-z0-9]+\.png$/);
  assert.ok(fs.existsSync(ok.body.path));
  assert.ok(ok.body.size > 0);

  // Extensão bloqueada
  const badExt = upload({ fileName: 'script.js', base64Data: 'Y29uc29sZS5sb2coMSk=' });
  assert.equal(badExt.status, 400);

  // Dados ausentes
  const empty = upload({ fileName: 'vazio.jpg', base64Data: '' });
  assert.equal(empty.status, 400);

  // Acima de 10 MB
  const big = upload({ fileName: 'huge.png', base64Data: Buffer.alloc(10 * 1024 * 1024 + 32).toString('base64') });
  assert.equal(big.status, 413);
});

test('collectSkills agrega comandos do projeto, workspace e builtins sem duplicar', () => {
  const proj = tmpDir('hud-sk-proj-');
  const ws = tmpDir('hud-sk-ws-');
  const home = tmpDir('hud-sk-home-');

  fs.mkdirSync(path.join(proj, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'commands', 'deploy.md'), '---\ndescription: Deploy seguro na VPS\n---\nPassos');
  fs.mkdirSync(path.join(proj, '.agents', 'skills', 'audit-sql'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.agents', 'skills', 'audit-sql', 'SKILL.md'), '---\ndescription: Audita queries SQL\n---\n');
  fs.mkdirSync(path.join(ws, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'skills', 'resumo.md'), 'Gera resumo executivo do dia\n');
  // Duplicata de /deploy no workspace não deve sobrescrever o do projeto
  fs.writeFileSync(path.join(ws, 'skills', 'deploy.md'), 'Outro deploy\n');

  const skills = collectSkills({ workspaceRoot: ws, cwd: proj, home });
  const byCmd = new Map(skills.map((s) => [s.cmd, s]));
  assert.equal(byCmd.get('/deploy').source, 'projeto');
  assert.equal(byCmd.get('/deploy').description, 'Deploy seguro na VPS');
  assert.equal(byCmd.get('/audit-sql').source, 'projeto');
  assert.equal(byCmd.get('/resumo').source, 'workspace');
  assert.equal(byCmd.get('/plan').source, 'builtin');
  assert.equal(skills.filter((s) => s.cmd === '/deploy').length, 1);
});

test('Fase 3A end-to-end: /api/session-meta, /api/upload e /api/skills no servidor HTTP', async () => {
  const dataDir = tmpDir('hud-p3-data-');
  const wsRoot = tmpDir('hud-p3-ws-');
  const proj = tmpDir('hud-p3-proj-');
  fs.mkdirSync(path.join(proj, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'commands', 'lint.md'), 'Executa linter completo\n');

  const token = 'aabbccdd1122334455667788';
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    token,
    pin: '12345678',
    workspaceRoot: wsRoot,
    name: 'TestP3',
  }));

  const now = Date.now();
  const fakeSessions = [
    {
      tool: 'Claude Code', id: 's1', project: 'Proj', cwd: proj, title: 'Sessão 1',
      models: new Set(['claude-sonnet-4']),
      start: new Date(now - 60000).toISOString(),
      end: new Date(now - 5000).toISOString(),
      mtime: now - 5000,
      lastStop: 'end_turn',
      input: 100, output: 50, cacheRead: 0, cacheWrite: 0,
      prompts: 1, toolCalls: 0, tools: {}, events: [],
    },
    {
      tool: 'Claude Code', id: 's2', project: 'Proj', cwd: proj, title: 'Sessão 2',
      models: new Set(['claude-sonnet-4']),
      start: new Date(now - 60000).toISOString(),
      end: new Date(now - 1000).toISOString(),
      mtime: now - 1000,
      lastStop: '',
      input: 100, output: 50, cacheRead: 0, cacheWrite: 0,
      prompts: 1, toolCalls: 0, tools: {}, events: [],
    },
  ];

  const app = createApp({
    dataDir,
    sources: { all: () => fakeSessions.map((s) => ({ ...s, models: new Set(s.models) })) },
    quotaFetchers: {},
    brands: false,
    log: () => {},
  });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  try {
    // 1. Fixa e renomeia s1 (que estava atrás de s2 por ter atividade mais antiga)
    const metaRes = await reqJson(port, 'POST', '/api/session-meta', token, {
      id: 's1',
      pinned: true,
      alias: 'Prioridade Máxima',
      group: 'Sprint',
    });
    assert.equal(metaRes.status, 200);
    assert.equal(metaRes.json.ok, true);

    // 2. Snapshot reflete ordenação pinned primeiro + alias/group
    const snapRes = await reqJson(port, 'GET', '/api/snapshot', token);
    assert.equal(snapRes.status, 200);
    assert.equal(snapRes.json.active[0].id, 's1');
    assert.equal(snapRes.json.active[0].pinned, true);
    assert.equal(snapRes.json.active[0].alias, 'Prioridade Máxima');
    assert.equal(snapRes.json.active[0].group, 'Sprint');

    // 3. Detalhe da sessão também traz os metadados
    const detRes = await reqJson(port, 'GET', '/api/session?id=s1', token);
    assert.equal(detRes.status, 200);
    assert.equal(detRes.json.pinned, true);
    assert.equal(detRes.json.alias, 'Prioridade Máxima');
    assert.equal(detRes.json.group, 'Sprint');

    // 4. Upload de imagem autenticado e bloqueado sem auth
    const unauth = await reqJson(port, 'POST', '/api/upload', '', { fileName: 'x.png', base64Data: 'AAAA' });
    assert.equal(unauth.status, 401);

    const pngB64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const upRes = await reqJson(port, 'POST', '/api/upload', token, { fileName: 'print.png', base64Data: pngB64 });
    assert.equal(upRes.status, 200);
    assert.equal(upRes.json.ok, true);
    assert.ok(fs.existsSync(upRes.json.path));

    const badUp = await reqJson(port, 'POST', '/api/upload', token, { fileName: 'shell.sh', base64Data: 'IyEvYmluL3No' });
    assert.equal(badUp.status, 400);

    // 5. GET /api/skills retorna comando do projeto + builtins
    const skRes = await reqJson(port, 'GET', `/api/skills?cwd=${encodeURIComponent(proj)}`, token);
    assert.equal(skRes.status, 200);
    assert.ok(skRes.json.skills.some((s) => s.cmd === '/lint' && s.source === 'projeto'));
    assert.ok(skRes.json.skills.some((s) => s.cmd === '/plan' && s.source === 'builtin'));
  } finally {
    app.server.close();
  }
});
