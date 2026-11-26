const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isSyncableRelPath, planWorkspaceSync } = require('../../src/core/workspace-sync');
const { createApp } = require('../../src/main');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-peer-sync-'));

const emptySources = () => ({
  loadAll: () => [],
  start: () => {},
  stop: () => {},
});

const emptyQuotas = {
  claude: async () => null,
  codex: async () => null,
  gemini: async () => null,
};

async function listen(app) {
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const addr = app.server.address();
  return `http://127.0.0.1:${addr.port}`;
}

async function reqJson(baseUrl, token, method, route, body) {
  const url = `${baseUrl}${route}${route.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

test('isSyncableRelPath bloqueia caminhos sensíveis, traversal e arquivos temporários', () => {
  assert.equal(isSyncableRelPath('workspace.json'), true);
  assert.equal(isSyncableRelPath('entities/2026-11-24_ai-hud/notes.md'), true);
  assert.equal(isSyncableRelPath('memory/ai-hud/MEMORY.md'), true);
  assert.equal(isSyncableRelPath('mcp-servers.json'), true);

  assert.equal(isSyncableRelPath('../config.json'), false);
  assert.equal(isSyncableRelPath('.ai-workspace/peer-sync-state.json'), false);
  assert.equal(isSyncableRelPath('.git/HEAD'), false);
  assert.equal(isSyncableRelPath('backups/foo.bak'), false);
  assert.equal(isSyncableRelPath('entities/a/temp.tmp'), false);
  assert.equal(isSyncableRelPath('.env'), false);
});

test('planWorkspaceSync executa 3-way diff corretamente (VPS primária + edições offline locais + conflito)', () => {
  // 1º sync: VPS vence workspace.json, pula seed local, baixa entidades remotas
  const first = planWorkspaceSync({
    localFiles: [
      { path: 'workspace.json', sha256: 'seed-ws', mtimeMs: 2000, size: 10 },
      { path: 'entities/seed/notes.md', sha256: 'seed-note', mtimeMs: 2000, size: 10 },
    ],
    remoteFiles: [
      { path: 'workspace.json', sha256: 'vps-ws', mtimeMs: 1000, size: 100 },
      { path: 'entities/proj-a/notes.md', sha256: 'vps-a', mtimeMs: 1000, size: 50 },
    ],
    lastState: {},
    preferRemote: true,
    skipInitialLocalPaths: ['entities/seed/notes.md'],
  });
  assert.deepEqual(first.pulls.map((x) => x.path), ['entities/proj-a/notes.md', 'workspace.json']);
  assert.deepEqual(first.pushes, []);

  // 2º sync: edição offline no local sobe (push), atualização na VPS desce (pull), conflito resolve por mtime
  const second = planWorkspaceSync({
    localFiles: [
      { path: 'workspace.json', sha256: 'vps-ws', mtimeMs: 1000, size: 100 },
      { path: 'entities/proj-a/notes.md', sha256: 'local-edited', mtimeMs: 5000, size: 60 },
      { path: 'entities/proj-offline/notes.md', sha256: 'new-offline', mtimeMs: 5500, size: 20 },
      { path: 'memory/ai-hud/MEMORY.md', sha256: 'mem-v1', mtimeMs: 1000, size: 30 },
      { path: 'mcp-servers.json', sha256: 'mcp-local-newer', mtimeMs: 9000, size: 40 },
    ],
    remoteFiles: [
      { path: 'workspace.json', sha256: 'vps-ws', mtimeMs: 1000, size: 100 },
      { path: 'entities/proj-a/notes.md', sha256: 'vps-a', mtimeMs: 1000, size: 50 },
      { path: 'memory/ai-hud/MEMORY.md', sha256: 'mem-v2', mtimeMs: 4000, size: 35 },
      { path: 'mcp-servers.json', sha256: 'mcp-remote-older', mtimeMs: 3000, size: 40 },
    ],
    lastState: {
      'workspace.json': 'vps-ws',
      'entities/proj-a/notes.md': 'vps-a',
      'memory/ai-hud/MEMORY.md': 'mem-v1',
      'mcp-servers.json': 'mcp-v0',
    },
    preferRemote: true,
  });
  assert.deepEqual(second.pulls.map((x) => x.path), ['memory/ai-hud/MEMORY.md']);
  assert.deepEqual(second.pushes.map((x) => x.path), [
    'entities/proj-a/notes.md',
    'entities/proj-offline/notes.md',
    'mcp-servers.json',
  ]);
  assert.equal(second.conflicts.length, 1);
  assert.equal(second.conflicts[0].path, 'mcp-servers.json');
  assert.equal(second.conflicts[0].winner, 'local');
});

test('sync bidirecional E2E entre VPS principal e servidor local (pull inicial, push offline, pull remoto e segurança)', async () => {
  const vpsDir = tmpDir();
  const localDir = tmpDir();
  const vpsToken = 'vps-secret-token-123456';
  const localToken = 'local-secret-token-654321';

  // Popula VPS com projetos reais e memória
  fs.writeFileSync(path.join(vpsDir, 'config.json'), JSON.stringify({
    name: 'VPS-Oracle',
    token: vpsToken,
    pin: '11111111',
    ollama: false,
  }));
  const vpsWs = path.join(vpsDir, 'workspace');
  fs.mkdirSync(path.join(vpsWs, 'entities', '2026-11-24_zapfry'), { recursive: true });
  fs.mkdirSync(path.join(vpsWs, 'memory', 'zapfry'), { recursive: true });
  fs.writeFileSync(path.join(vpsWs, 'workspace.json'), JSON.stringify({
    format: 'ai-workspace',
    version: 1,
    groups: ['Jogos'],
    entities: [{ id: 'zapfry', title: 'ZapFry', folder: 'entities/2026-11-24_zapfry' }],
  }, null, 2));
  fs.writeFileSync(path.join(vpsWs, 'entities', '2026-11-24_zapfry', 'notes.md'), '# ZapFry da VPS\n');
  fs.writeFileSync(path.join(vpsWs, 'memory', 'zapfry', 'MEMORY.md'), '# Memória ZapFry\n');

  const vpsApp = createApp({ dataDir: vpsDir, sources: emptySources(), quotaFetchers: emptyQuotas, brands: false, log: () => {} });
  const vpsUrl = await listen(vpsApp);

  // Local começa apenas com o seed padrão e VPS-Oracle marcada como primary: true
  fs.writeFileSync(path.join(localDir, 'config.json'), JSON.stringify({
    name: 'MateusNote',
    token: localToken,
    pin: '22222222',
    ollama: false,
    peers: [{ name: 'VPS-Oracle', url: vpsUrl, token: vpsToken, primary: true, ollama: false }],
  }));
  const localWs = path.join(localDir, 'workspace');
  fs.mkdirSync(path.join(localWs, 'entities', '2026-11-24_ai-hud-workspace'), { recursive: true });
  fs.writeFileSync(path.join(localWs, 'workspace.json'), JSON.stringify({
    format: 'ai-workspace',
    version: 1,
    entities: [{ id: 'ai-hud-workspace', title: 'Seed', folder: 'entities/2026-11-24_ai-hud-workspace' }],
  }, null, 2));
  fs.writeFileSync(path.join(localWs, 'entities', '2026-11-24_ai-hud-workspace', 'notes.md'), '# Seed local\n');

  const localApp = createApp({ dataDir: localDir, sources: emptySources(), quotaFetchers: emptyQuotas, brands: false, log: () => {} });
  const localUrl = await listen(localApp);

  try {
    // 1. Sync inicial: local puxa ZapFry + memória da VPS sem subir o seed local
    const r1 = await reqJson(localUrl, localToken, 'POST', '/api/workspace/peer-sync', {});
    assert.equal(r1.status, 200);
    assert.equal(r1.json.ok, true);
    assert.equal(r1.json.pulled, 3);
    assert.equal(r1.json.pushed, 0);
    assert.match(fs.readFileSync(path.join(localWs, 'workspace.json'), 'utf8'), /ZapFry/);
    assert.equal(fs.readFileSync(path.join(localWs, 'memory', 'zapfry', 'MEMORY.md'), 'utf8'), '# Memória ZapFry\n');
    assert.equal(fs.existsSync(path.join(vpsWs, 'entities', '2026-11-24_ai-hud-workspace')), false);

    // 2. Edição offline no local -> próximo sync sobe automaticamente para a VPS
    fs.writeFileSync(path.join(localWs, 'entities', '2026-11-24_zapfry', 'notes.md'), '# ZapFry editado offline no notebook\n');
    fs.writeFileSync(path.join(localWs, 'memory', 'zapfry', 'pinned.md'), '# Regra criada offline\n');
    const r2 = await reqJson(localUrl, localToken, 'POST', '/api/workspace/peer-sync', {});
    assert.equal(r2.status, 200);
    assert.equal(r2.json.pushed, 2);
    assert.equal(r2.json.pulled, 0);
    assert.equal(fs.readFileSync(path.join(vpsWs, 'entities', '2026-11-24_zapfry', 'notes.md'), 'utf8'), '# ZapFry editado offline no notebook\n');
    assert.equal(fs.readFileSync(path.join(vpsWs, 'memory', 'zapfry', 'pinned.md'), 'utf8'), '# Regra criada offline\n');

    // 3. Edição na VPS -> próximo sync desce para o local
    fs.writeFileSync(path.join(vpsWs, 'memory', 'zapfry', 'MEMORY.md'), '# Memória atualizada na VPS\n');
    const r3 = await reqJson(localUrl, localToken, 'POST', '/api/workspace/peer-sync', {});
    assert.equal(r3.status, 200);
    assert.equal(r3.json.pulled, 1);
    assert.equal(r3.json.pushed, 0);
    assert.equal(fs.readFileSync(path.join(localWs, 'memory', 'zapfry', 'MEMORY.md'), 'utf8'), '# Memória atualizada na VPS\n');

    // 4. Segurança: path traversal bloqueado
    const bad = await reqJson(vpsUrl, vpsToken, 'GET', '/api/workspace/peer-sync/file?path=../config.json');
    assert.equal(bad.status, 400);
  } finally {
    await new Promise((resolve) => localApp.server.close(resolve));
    await new Promise((resolve) => vpsApp.server.close(resolve));
    fs.rmSync(localDir, { recursive: true, force: true });
    fs.rmSync(vpsDir, { recursive: true, force: true });
  }
});
