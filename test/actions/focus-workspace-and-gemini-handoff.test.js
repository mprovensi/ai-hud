const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../../src/main');
const { createFocus } = require('../../src/actions/focus');
const { createSharedSessionIndex } = require('../../src/collect/shared-sessions');
const { createSharedSessions } = require('../../src/actions/shared-sessions');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function listen(app) {
  return new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${app.server.address().port}`);
    });
  });
}

function reqJson(baseUrl, token, method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const sep = route.includes('?') ? '&' : '?';
    const req = http.request(`${baseUrl}${route}${sep}t=${encodeURIComponent(token)}`, {
      method,
      headers: {
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, text: raw, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('shared-sessions normaliza prefixo \\\\?\\ e costura sessão Gemini (agy) lenta via ID da sessão compartilhada no prompt', () => {
  const dir = mkTmp('ai-hud-gemini-ho-');
  try {
    const store = createSharedSessions({ workspaceRoot: path.join(dir, 'ws') });
    const proj = path.join(dir, 'vulnerabilidades');
    fs.mkdirSync(proj, { recursive: true });

    // Simula cwd com prefixo estendido \\?\ vindo do Codex no Windows
    const created = store.create({
      cwd: `\\\\?\\${proj}`,
      goal: 'Analise CVEs',
      tool: 'Codex',
      nativeSessionId: 'rollout-2026-11-27T12-50-05-01a21db3-1086-70d2-b546-8baaa82fb366',
    });
    assert.ok(created.session);
    assert.ok(!created.session.cwd.startsWith('\\\\?\\'), 'cwd persistido não deve carregar prefixo \\\\?\\');

    // Simula que `agy` demorou >15s e não foi adicionado em natives[], mas o prompt cita `Sessão compartilhada AI HUD: <id>`
    const now = Date.now();
    const sessions = [
      {
        id: 'rollout-2026-11-27T12-50-05-01a21db3-1086-70d2-b546-8baaa82fb366',
        tool: 'Codex',
        cwd: proj,
        start: new Date(now - 60000).toISOString(),
        end: new Date(now - 30000).toISOString(),
        firstPrompt: 'Analise CVEs',
        history: [{ role: 'user', content: 'Analise CVEs', at: now - 60000 }],
      },
      {
        id: 'b7e2b770-ec07-4063-a32b-458400f11c13',
        tool: 'Gemini',
        cwd: proj,
        start: new Date(now - 10000).toISOString(),
        end: new Date(now - 1000).toISOString(),
        firstPrompt: `Continuação de sessão por Handoff (vindo de Codex).\n\nSessão compartilhada AI HUD: ${created.session.id} (rev 2).`,
        history: [{ role: 'assistant', content: 'Assumi via Gemini.', at: now - 1000 }],
      },
    ];

    const idx = createSharedSessionIndex().indexForSessions(sessions);
    assert.equal(idx.redirectToHead.get('rollout-2026-11-27T12-50-05-01a21db3-1086-70d2-b546-8baaa82fb366'), 'b7e2b770-ec07-4063-a32b-458400f11c13');
    assert.equal(idx.supersededIds.has('rollout-2026-11-27T12-50-05-01a21db3-1086-70d2-b546-8baaa82fb366'), true);
    assert.deepEqual(idx.chainByHeadId.get('b7e2b770-ec07-4063-a32b-458400f11c13').tools, ['Codex', 'Gemini']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/focus abre projeto + sessão vinculados direto no AI Workspace Desktop via --open-url', async () => {
  const dataDir = mkTmp('ai-hud-focus-ws-');
  const projDir = path.join(dataDir, 'vulnerabilidades');
  fs.mkdirSync(projDir, { recursive: true });
  const token = 'test-focus-token-123456';
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    name: 'MateusNote',
    token,
    pin: '12345678',
    ollama: false,
    peers: [{
      name: 'VPS-Oracle',
      primary: true,
      url: 'http://100.98.174.63:8787',
      publicUrl: 'https://ai-hud-vps.tail2a765a.ts.net',
      token: 'vps-tok-123',
    }],
  }));

  const spawnedCalls = [];
  const fakeFocus = createFocus({
    platform: 'win32',
    desktopExe: 'C:\\Fake\\ai-hud-desktop.exe',
    spawnFn: (exe, args) => {
      spawnedCalls.push({ exe, args });
      return { unref: () => {} };
    },
  });

  const now = Date.now();
  const sessId = 'rollout-2026-11-27T12-50-05-01a21db3-1086-70d2-b546-8baaa82fb366';
  const app = createApp({
    dataDir,
    sources: {
      all: () => [{
        id: sessId,
        tool: 'Codex',
        where: 'terminal',
        project: 'vulnerabilidades',
        cwd: projDir,
        models: new Set(['gpt-5.4']),
        start: new Date(now - 20000).toISOString(),
        end: new Date(now - 1000).toISOString(),
        input: 100, output: 50, cacheRead: 0, cacheWrite: 0,
        context: 150, contextWindow: 200000, prompts: 1, toolCalls: 0,
        tools: {}, files: {}, events: [],
      }],
      start: () => {},
      stop: () => {},
    },
    focus: fakeFocus,
    quotaFetchers: {},
    brands: false,
    log: () => {},
  });
  const baseUrl = await listen(app);

  try {
    // 1. Cria projeto no AI Workspace vinculado à pasta `projDir`
    const created = await reqJson(baseUrl, token, 'POST', '/api/workspace/entity', {
      title: 'Vulnerabilidades',
      projectBindings: [{ machine: 'MateusNote', cwd: projDir }],
    });
    assert.equal(created.status, 200);
    const entityId = created.json.entity.id;

    // 2. Chama POST /api/focus na sessão vinculada -> deve abrir AI Workspace Desktop com ?project=&session=
    const fr = await reqJson(baseUrl, token, 'POST', '/api/focus', { id: sessId });
    assert.equal(fr.status, 200);
    assert.equal(fr.json.ok, true);
    assert.match(fr.json.message, /AI Workspace/);
    assert.equal(spawnedCalls.length, 1);
    assert.equal(spawnedCalls[0].exe, 'C:\\Fake\\ai-hud-desktop.exe');
    assert.equal(spawnedCalls[0].args[0], '--open-url');
    const opened = new URL(spawnedCalls[0].args[1]);
    assert.equal(opened.pathname, '/workspace');
    assert.equal(opened.searchParams.get('project'), entityId);
    assert.equal(opened.searchParams.get('session'), sessId);

    // 3. Simula foco encaminhado a partir do iPad via VPN (hubOrigin = http://10.10.10.1:8787):
    // deve usar a publicUrl do peer primário configurada no PC (https://ai-hud-vps.tail2a765a.ts.net)
    const frIpad = await reqJson(baseUrl, token, 'POST', '/api/focus', {
      id: sessId,
      hubSessionId: `m0:${sessId}`,
      hubOrigin: 'http://10.10.10.1:8787',
    });
    assert.equal(frIpad.status, 200);
    const openedIpad = new URL(spawnedCalls[1].args[1]);
    assert.equal(openedIpad.origin, 'https://ai-hud-vps.tail2a765a.ts.net');
    assert.equal(openedIpad.searchParams.get('project'), entityId);
    assert.equal(openedIpad.searchParams.get('session'), `m0:${sessId}`);
    assert.equal(openedIpad.searchParams.get('t'), 'vps-tok-123');
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
