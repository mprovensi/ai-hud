// Testes direcionados de regressão e segurança para os 18 achados da revisão (R01–R18).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { isCwdAllowed, isWithinRoot, normalizePath } = require('../../src/core/path-guard');
const { evaluateStageAdvance } = require('../../src/core/egm');
const { selectDreamBatch, buildSessionDigest } = require('../../src/core/memory');
const { writeAtomicWithBackup, resolveSafeContainedTarget } = require('../../src/infra/workspace-paths');
const { createPendingStore } = require('../../src/actions/pending');
const { createSessionMeta } = require('../../src/actions/session-meta');
const { createProjectPins } = require('../../src/actions/projects');
const { saveProjectDoc, savePortableBoard } = require('../../src/actions/workspace/project-storage');
const { createWorkspaceActions } = require('../../src/actions/workspace');
const { createProjectRunner } = require('../../src/actions/project-runner');
const { createMemoryActions } = require('../../src/actions/memory');
const { parsePorcelain, createWorkspaceSync } = require('../../src/actions/workspace/sync');
const { createWebAuthn } = require('../../src/api/webauthn');
const { attachWsPty, isAllowedOrigin } = require('../../src/api/ws-pty');
const { encodeFrame } = require('../../src/core/websocket');
const createWorkspaceRoutes = require('../../src/api/routes/workspace');
const createMemoryRoutes = require('../../src/api/routes/memory');
const { updateBoardStatus, handleRpc } = require('../../integrations/mcp/memory-server');

const send = (res, status, type, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': type, ...headers });
  res.end(body);
};

function rmSafe(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }); } catch {}
}

function mkTmp(prefix = 'ai-hud-rev-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeRes() {
  return new Promise((resolve) => {
    const res = {
      status: 0,
      headers: {},
      body: '',
      writeHead(s, h = {}) { this.status = s; this.headers = h; },
      end(b = '') { this.body = Buffer.isBuffer(b) ? b.toString('utf8') : String(b || ''); resolve(this); },
    };
    res._ready = true;
    resolve(res);
  });
}

function invokeRoute(routes, method, urlPath, { body = null, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const u = new URL(urlPath, 'http://localhost');
  const route = routes.find((r) => r.method === method && r.path === u.pathname);
  assert.ok(route, `rota não encontrada: ${method} ${u.pathname}`);
  return new Promise((resolve, reject) => {
    const res = {
      status: 0,
      headers: {},
      body: '',
      writeHead(s, h = {}) { this.status = s; this.headers = h; },
      end(b = '') {
        this.body = Buffer.isBuffer(b) ? b.toString('utf8') : String(b || '');
        resolve(this);
      },
    };
    const req = { method, url: urlPath, headers, socket: { remoteAddress } };
    Promise.resolve(route.handler({ req, res, url: u, body })).catch(reject);
  });
}

// ---- R01: path-guard traversal ----
test('R01: path-guard rejeita .. traversal, prefixos irmãos, drive-relative e UNC fora da raiz', () => {
  assert.equal(isCwdAllowed('C:\\safe\\..\\outside', { allowedRoots: ['C:\\safe'], strict: true, platform: 'win32' }).ok, false);
  assert.equal(isCwdAllowed('C:/safe/../outside', { allowedRoots: ['C:\\safe'], strict: true, platform: 'win32' }).ok, false);
  assert.equal(isCwdAllowed('C:\\safe2\\sub', { allowedRoots: ['C:\\safe'], strict: true, platform: 'win32' }).ok, false);
  assert.equal(isCwdAllowed('C:safe\\sub', { allowedRoots: ['C:\\safe'], strict: true, platform: 'win32' }).ok, false);
  assert.equal(isCwdAllowed('/safe/../outside', { allowedRoots: ['/safe'], strict: true, platform: 'linux' }).ok, false);
  assert.equal(isCwdAllowed('\\\\srv\\share\\safe\\..\\other', { allowedRoots: ['\\\\srv\\share\\safe'], strict: true, platform: 'win32' }).ok, false);
  assert.equal(isCwdAllowed('C:\\safe\\sub\\file', { allowedRoots: ['C:\\safe'], strict: true, platform: 'win32' }).ok, true);
  assert.equal(isWithinRoot('/safe', '/safe/a/b', 'linux'), true);
  assert.equal(normalizePath('C:\\safe\\sub\\..', 'win32'), 'C:\\safe');
});

// ---- R02: ?local=1 não contorna autorização ----
test('R02: ?local=1 nas rotas de workspace não contorna autorização de pasta', async () => {
  const dir = mkTmp('ai-hud-r02-');
  const forbiddenDir = mkTmp('ai-hud-r02-forb-');
  fs.writeFileSync(path.join(forbiddenDir, 'README.md'), '# segredo\n');
  try {
    const json = (res, v, s = 200) => send(res, s, 'application/json', JSON.stringify(v));
    const text = (res, s, m) => send(res, s, 'text/plain; charset=utf-8', m);
    const routes = createWorkspaceRoutes({
      dataDir: dir,
      config: {},
      collector: { current: () => ({ sessions: [] }) },
      peers: { list: [], forward: async () => ({ status: 500, text: '' }) },
      machineName: 'Hub',
      workspace: {},
      workspaceSync: null,
      workspaceWorkflow: null,
      relay: () => {},
      send,
      json,
      text,
    });

    const r0 = await invokeRoute(routes, 'GET', `/api/workspace/project/doc?local=0&cwd=${encodeURIComponent(forbiddenDir)}&path=README.md`);
    const r1 = await invokeRoute(routes, 'GET', `/api/workspace/project/doc?local=1&cwd=${encodeURIComponent(forbiddenDir)}&path=README.md`);
    const rb = await invokeRoute(routes, 'GET', `/api/workspace/project/board?local=1&cwd=${encodeURIComponent(forbiddenDir)}`);
    assert.equal(r0.status, 403);
    assert.equal(r1.status, 403);
    assert.equal(rb.status, 403);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(forbiddenDir, { recursive: true, force: true });
  }
});

// ---- R03: rotas de memória autorizam cwd ----
test('R03: rotas /api/memory/* rejeitam cwd não autorizado com 403 em leitura, save, dream, undo e bridges', async () => {
  const dir = mkTmp('ai-hud-r03-');
  const forbiddenDir = mkTmp('ai-hud-r03-forb-');
  try {
    const json = (res, v, s = 200) => send(res, s, 'application/json', JSON.stringify(v));
    const text = (res, s, m) => send(res, s, 'text/plain; charset=utf-8', m);
    const collector = { current: () => ({ sessions: [], snapshot: { active: [], recent: [] } }) };
    const memory = createMemoryActions({ dataDir: dir, config: { strictRemoteCwd: true }, collector });
    const routes = createMemoryRoutes({
      dataDir: dir,
      config: { strictRemoteCwd: true },
      collector,
      memory,
      json,
      text,
    });

    const g = await invokeRoute(routes, 'GET', `/api/memory?cwd=${encodeURIComponent(forbiddenDir)}&mode=in-repo`);
    const s = await invokeRoute(routes, 'PUT', '/api/memory/file', { body: { cwd: forbiddenDir, mode: 'in-repo', file: 'MEMORY.md', content: 'x' } });
    const d = await invokeRoute(routes, 'POST', '/api/memory/dream', { body: { cwd: forbiddenDir, mode: 'in-repo' } });
    const u = await invokeRoute(routes, 'POST', '/api/memory/undo', { body: { cwd: forbiddenDir, mode: 'in-repo' } });
    const b = await invokeRoute(routes, 'POST', '/api/memory/bridges', { body: { cwd: forbiddenDir, mode: 'in-repo' } });

    assert.equal(g.status, 403);
    assert.equal(s.status, 403);
    assert.equal(d.status, 403);
    assert.equal(u.status, 403);
    assert.equal(b.status, 403);
    assert.equal(fs.existsSync(path.join(forbiddenDir, 'CLAUDE.md')), false);
    assert.equal(fs.existsSync(path.join(forbiddenDir, '.ai-memory')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(forbiddenDir, { recursive: true, force: true });
  }
});

// ---- R04: symlink/junction não permite criar documento fora da raiz ----
test('R04: criação de documento novo através de junction/symlink fora da raiz é bloqueada com 403', () => {
  const projectDir = mkTmp('ai-hud-r04-proj-');
  const outsideDir = mkTmp('ai-hud-r04-out-');
  try {
    fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
    const linkPath = path.join(projectDir, 'docs', 'linked');
    fs.symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

    const res = saveProjectDoc({ cwd: projectDir, relPath: 'docs/linked/new.md', content: '# escape' });
    assert.equal(res.status, 403);
    assert.equal(fs.existsSync(path.join(outsideDir, 'new.md')), false);

    // Também bloqueia .ai-workspace ligado a outra pasta
    const proj2 = mkTmp('ai-hud-r04-proj2-');
    try {
      fs.symlinkSync(outsideDir, path.join(proj2, '.ai-workspace'), process.platform === 'win32' ? 'junction' : 'dir');
      const rb = savePortableBoard({
        cwd: proj2,
        content: { format: 'ai-card', version: 1, template: 'board', title: 'T', summary: '', items: [] },
      });
      assert.equal(rb.status, 403);
      assert.equal(fs.existsSync(path.join(outsideDir, 'board.card.json')), false);
    } finally {
      fs.rmSync(proj2, { recursive: true, force: true });
    }

    // Caso permitido dentro do projeto sem escape continua funcionando
    const ok = saveProjectDoc({ cwd: projectDir, relPath: 'docs/valid.md', content: '# ok' });
    assert.equal(ok.status, 200);
    assert.equal(fs.readFileSync(path.join(projectDir, 'docs', 'valid.md'), 'utf8'), '# ok');
    assert.equal(resolveSafeContainedTarget(projectDir, 'docs/linked/sub/file.md').ok, false);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ---- R05: HTML executável não aceita token global `?t=` em navegação/iframe ----
test('R05: GET /api/workspace/entity/asset recusa navegação HTML com ?t= mas permite fetch autenticado para srcDoc', async () => {
  const dir = mkTmp('ai-hud-r05-');
  try {
    const wsActions = createWorkspaceActions({ dataDir: dir, config: {} });
    const created = wsActions.createEntity({ title: 'Demo' });
    assert.equal(created.status, 200);
    const ent = created.body.entity;
    const entDir = path.join(dir, 'workspace', ent.folder);
    fs.writeFileSync(path.join(entDir, 'report.html'), '<html><body><script>1</script></body></html>');

    const json = (res, v, s = 200) => send(res, s, 'application/json', JSON.stringify(v));
    const text = (res, s, m) => send(res, s, 'text/plain; charset=utf-8', m);
    const routes = createWorkspaceRoutes({
      dataDir: dir,
      config: { token: 'SECRET_TOK' },
      collector: { current: () => ({ sessions: [] }) },
      peers: { list: [] },
      machineName: 'Hub',
      workspace: wsActions,
      workspaceSync: null,
      workspaceWorkflow: null,
      relay: () => {},
      send,
      json,
      text,
    });

    const iframeWithToken = await invokeRoute(
      routes,
      'GET',
      `/api/workspace/entity/asset?id=${encodeURIComponent(ent.id)}&path=report.html&t=SECRET_TOK`,
      { headers: { 'sec-fetch-dest': 'iframe', accept: 'text/html' } },
    );
    assert.equal(iframeWithToken.status, 400);

    const fetchForSrcDoc = await invokeRoute(
      routes,
      'GET',
      `/api/workspace/entity/asset?id=${encodeURIComponent(ent.id)}&path=report.html&t=SECRET_TOK`,
      { headers: { 'x-ai-hud-fetch': '1', accept: 'text/plain' } },
    );
    assert.equal(fetchForSrcDoc.status, 200);
    assert.match(fetchForSrcDoc.headers['Content-Security-Policy'] || '', /connect-src 'none'/);
    assert.equal(fetchForSrcDoc.headers['Referrer-Policy'], 'no-referrer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- R06 + R07 + R09: WebSocket malformed upgrade, Origin validation & biometric revocation ----
test('R06/R07/R09: Upgrade malformado não derruba servidor, Origin de outra porta é recusada e bloqueio biométrico encerra PTY aberto', async () => {
  const dir = mkTmp('ai-hud-ws-');
  const projDir = mkTmp('ai-hud-ws-proj-');
  const config = { token: 'TOK123', pin: '12345678', allowedRoots: [projDir] };
  const webauthn = createWebAuthn({ dataDir: dir, config });
  // Injeta duas credenciais biométricas sintéticas em passkeys.json e cria duas sessões distintas (A e B)
  fs.writeFileSync(path.join(dir, 'passkeys.json'), JSON.stringify({
    timeoutMs: 900000,
    credentials: [{ id: 'cred-A', publicKey: 'dummy', signCount: 0 }, { id: 'cred-B', publicKey: 'dummy', signCount: 0 }],
  }));
  const sidA = webauthn.createSession('cred-A');
  const sidB = webauthn.createSession('cred-B');

  const writtenInputs = [];
  const fakePtySess = {
    cmd: 'shell',
    cwd: projDir,
    key: 'k1',
    exited: false,
    history: () => Buffer.alloc(0),
    onData: () => () => {},
    onExit: () => () => {},
    write: (data) => writtenInputs.push(data),
    resize: () => {},
    kill: () => {},
  };

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('alive');
  });
  attachWsPty({
    server,
    dataDir: dir,
    config,
    webauthn,
    ptyManager: { getOrCreate: () => fakePtySess },
    peers: { list: [] },
    collector: { current: () => ({ sessions: [] }) },
    machineName: 'Hub',
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  function rawUpgrade(reqText) {
    return new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write(reqText));
      let data = '';
      sock.on('data', (c) => {
        data += c.toString('utf8');
        if (data.includes('\r\n\r\n')) resolve({ sock, head: data });
      });
      sock.on('close', () => resolve({ sock, head: data }));
      sock.on('error', () => resolve({ sock, head: data }));
    });
  }

  try {
    // R06: request-target malformado `//%` sem login não derruba o servidor
    const bad = await rawUpgrade(`GET //% HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    assert.match(bad.head, /400 Bad Request/);
    bad.sock.destroy();

    // Confirma servidor ainda vivo
    const alive = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let s = '';
        res.on('data', (c) => { s += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: s }));
      }).on('error', reject);
    });
    assert.equal(alive.status, 200);
    assert.equal(alive.body, 'alive');

    // R07: Origin de outra porta do mesmo host é rejeitada com 403
    assert.equal(isAllowedOrigin({ headers: { host: `127.0.0.1:${port}`, origin: 'http://127.0.0.1:3000' }, socket: { remoteAddress: '127.0.0.1' } }), false);
    assert.equal(isAllowedOrigin({ headers: { host: `127.0.0.1:${port}`, origin: 'null' }, socket: { remoteAddress: '127.0.0.1' } }), false);
    assert.equal(isAllowedOrigin({ headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }, socket: { remoteAddress: '127.0.0.1' } }), true);

    const evilOrigin = await rawUpgrade(
      `GET /ws/pty?cwd=${encodeURIComponent(projDir)} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Origin: http://127.0.0.1:3000\r\n` +
      `Cookie: hud=TOK123\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    assert.match(evilOrigin.head, /403 Forbidden Origin/);
    evilOrigin.sock.destroy();

    // R09: abre WS com sessão biométrica A e sessão B; revoga A → fecha A e preserva B
    const wsA = await rawUpgrade(
      `GET /ws/pty?cwd=${encodeURIComponent(projDir)} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Origin: http://127.0.0.1:${port}\r\n` +
      `Cookie: hud_bio=${sidA}; hud_bio_id=cred-A\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    assert.match(wsA.head, /101 Switching Protocols/);

    const wsB = await rawUpgrade(
      `GET /ws/pty?cwd=${encodeURIComponent(projDir)} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Origin: http://127.0.0.1:${port}\r\n` +
      `Cookie: hud_bio=${sidB}; hud_bio_id=cred-B\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    assert.match(wsB.head, /101 Switching Protocols/);

    const closedA = new Promise((resolve) => wsA.sock.once('close', () => resolve(true)));
    webauthn.revokeSession(sidA);
    assert.equal(await closedA, true);

    // Envia frame mascarado em B para confirmar que B continua autorizada
    const payloadB = Buffer.from(JSON.stringify({ type: 'in', data: 'echo-B' }));
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.alloc(payloadB.length);
    for (let i = 0; i < payloadB.length; i++) masked[i] = payloadB[i] ^ mask[i % 4];
    const frameB = Buffer.concat([Buffer.from([0x81, 0x80 | payloadB.length]), mask, masked]);
    wsB.sock.write(frameB);
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(writtenInputs.includes('echo-B'));

    wsB.sock.destroy();
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});

// ---- R10: ProjectRunner não deixa processo órfão em falha parcial ----
test('R10: ProjectRunner valida subpastas antes de lançar e desfaz lançamentos parciais se spawn falhar', () => {
  const dir = mkTmp('ai-hud-r10-');
  const spawned = [];
  const killed = [];
  let failOnSecond = false;
  const fakeSpawn = (cmd) => {
    if (failOnSecond && spawned.length >= 1) throw new Error('boom spawn');
    const child = new EventEmitter();
    child.pid = 9000 + spawned.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed.push(child.pid); child.emit('close', 1); };
    spawned.push({ cmd, pid: child.pid });
    return child;
  };
  try {
    fs.mkdirSync(path.join(dir, 'front'), { recursive: true });
    const runner = createProjectRunner({ spawnFn: fakeSpawn, platform: 'linux' });
    runner.saveConfig({
      cwd: dir,
      runConfig: {
        defaultProfile: 'comp',
        profiles: [{
          id: 'comp',
          name: 'Composto',
          kind: 'compound',
          processes: [
            { id: 'p1', name: 'Front', cmd: 'echo 1', cwd: 'front' },
            { id: 'p2', name: 'Back', cmd: 'echo 2', cwd: 'inexistente' },
          ],
        }],
      },
    });
    const rBadCwd = runner.start({ cwd: dir, profileId: 'comp' });
    assert.equal(rBadCwd.status, 400);
    assert.equal(spawned.length, 0);

    // Agora com ambas subpastas válidas mas erro de spawn no 2º processo
    fs.mkdirSync(path.join(dir, 'back'), { recursive: true });
    runner.saveConfig({
      cwd: dir,
      runConfig: {
        defaultProfile: 'comp2',
        profiles: [{
          id: 'comp2',
          name: 'Composto 2',
          kind: 'compound',
          processes: [
            { id: 'p1', name: 'Front', cmd: 'echo 1', cwd: 'front' },
            { id: 'p2', name: 'Back', cmd: 'echo 2', cwd: 'back' },
          ],
        }],
      },
    });
    failOnSecond = true;
    const origKill = process.kill;
    const killedPids = [];
    process.kill = (pid) => { killedPids.push(pid); };
    try {
      const rFail = runner.start({ cwd: dir, profileId: 'comp2' });
      assert.equal(rFail.status, 500);
      assert.equal(spawned.length, 1);
      assert.ok(killed.length > 0 || killedPids.length > 0, 'primeiro processo deve ser encerrado no rollback');
      assert.equal(runner.status({ cwd: dir }).body.running, false);
    } finally {
      process.kill = origKill;
    }
  } finally {
    rmSafe(dir);
  }
});

// ---- R11 + R12: Dreaming em lotes explícitos e proteção contra edição concorrente ----
test('R11/R12: Dreaming marca apenas o lote enviado (12 de 15) e retorna 409 sem sobrescrever edição concorrente', async () => {
  const dir = mkTmp('ai-hud-r11-');
  try {
    const sessions = Array.from({ length: 15 }, (_, i) => ({
      id: `s-${String(i + 1).padStart(2, '0')}`,
      tool: 'Claude Code',
      project: 'demo',
      cwd: dir,
      end: new Date(1700000000000 + i * 60000).toISOString(),
      lastPrompt: `Prompt ${i + 1}`,
      lastReply: `Resposta ${i + 1}`,
      history: [{ role: 'user', content: `Prompt ${i + 1}` }],
    }));

    assert.equal(selectDreamBatch(sessions, 12).length, 12);
    assert.equal(selectDreamBatch(sessions, 12)[0].id, 's-01');
    const dig = buildSessionDigest(selectDreamBatch(sessions, 12), { maxSessions: 12 });
    assert.match(dig, /id=s-01/);
    assert.doesNotMatch(dig, /id=s-13/);

    let releaseModel;
    let notifyModelStarted;
    const modelStarted = new Promise((r) => { notifyModelStarted = r; });
    let modelCalls = 0;
    const memory = createMemoryActions({
      dataDir: dir,
      config: { dream: { engines: ['Claude Code'] } },
      collector: { current: () => ({ sessions, snapshot: { active: [], recent: [] } }) },
      claudeExe: process.execPath,
      exec: (_cmd, _args, _opts, cb) => cb && cb(null, '', ''),
      runModel: async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          notifyModelStarted();
          await new Promise((r) => { releaseModel = r; });
        }
        return JSON.stringify({
          memoryMd: '# Memória consolidada pelo Dreaming\n',
          currentStateMd: '# Estado atual\n',
          decisionsAppend: '- [Claude] Decisão teste',
          pitfallsAppend: '',
          sessionNoteMd: 'Resumo do lote',
          summary: 'consolidado',
        });
      },
    });

    // R12: dispara Dreaming, edita MEMORY.md concorrentemente antes do modelo resolver → deve retornar 409 preservando edição
    const p1 = memory.dream({ project: 'demo', cwd: dir, mode: 'workspace-hub', engine: 'Claude Code', ignoreQuota: true });
    await modelStarted;
    const humanEdit = memory.saveMemoryFile({ project: 'demo', cwd: dir, mode: 'workspace-hub', file: 'MEMORY.md', content: '# Edição humana concorrente\n' });
    assert.equal(humanEdit.status, 200);
    releaseModel();
    const res1 = await p1;
    assert.equal(res1.status, 409);
    assert.equal(res1.body.conflict, true);
    const memDisk = fs.readFileSync(path.join(dir, 'workspace', 'memory', 'demo', 'MEMORY.md'), 'utf8');
    assert.equal(memDisk, '# Edição humana concorrente\n');

    // R11: agora roda Dreaming normalmente → processa 12 de 15 e deixa 3 restantes
    const res2 = await memory.dream({ project: 'demo', cwd: dir, mode: 'workspace-hub', engine: 'Claude Code', ignoreQuota: true });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.sessionsProcessed, 12);
    assert.equal(res2.body.remainingCount, 3);

    // Segunda rodada processa as 3 restantes (s-13..s-15)
    const res3 = await memory.dream({ project: 'demo', cwd: dir, mode: 'workspace-hub', engine: 'Claude Code', ignoreQuota: true });
    assert.equal(res3.status, 200);
    assert.equal(res3.body.sessionsProcessed, 3);
    assert.equal(res3.body.remainingCount, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- R14: falha de persistência em pending/session-meta/pins faz rollback e sinaliza erro ----
test('R14: falha de escrita em pending.json, session-meta e pins faz rollback e propaga erro explícito', () => {
  const dir = mkTmp('ai-hud-r14-');
  try {
    const pendingFile = path.join(dir, 'pending.json');
    // Ocupa pending.json.tmp com um diretório para forçar erro determinístico de escrita
    fs.mkdirSync(`${pendingFile}.tmp`);
    const store = createPendingStore(pendingFile);
    const replies = store.section('replies');
    assert.throws(() => replies.set('sess-1', { text: 'oi', at: 1 }), /Falha ao gravar/);
    assert.equal(replies.has('sess-1'), false, 'rollback em memória deve remover entrada não persistida');

    // Session meta rollback
    const metaFile = path.join(dir, 'session-meta.json');
    fs.mkdirSync(`${metaFile}.tmp`);
    const meta = createSessionMeta(dir);
    const rMeta = meta.set({ id: 's1', pinned: true });
    assert.equal(rMeta.status, 500);
    assert.equal(meta.get('s1'), null);

    // Project pins rollback
    const cfg = {};
    const pinFn = createProjectPins({ config: cfg, saveConfig: () => false });
    const rPin = pinFn({ cwd: dir, pinned: true });
    assert.equal(rPin.status, 500);
    assert.equal(cfg.pinnedProjects, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- R15: falha de backup obrigatório preserva arquivo original ----
test('R15: falha ao criar backup obrigatório aborta gravação e preserva conteúdo anterior', () => {
  const dir = mkTmp('ai-hud-r15-');
  try {
    const target = path.join(dir, 'doc.md');
    const blockingFile = path.join(dir, 'not-a-dir');
    fs.writeFileSync(target, 'ORIGINAL');
    fs.writeFileSync(blockingFile, 'bloqueio');

    assert.throws(
      () => writeAtomicWithBackup({ filePath: target, content: 'NOVO', backupDir: blockingFile, tag: 'doc.md' }),
      /backup obrigatório/i,
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');

    // Com backupDir válido, gera backup íntegro antes de substituir
    const okBackupDir = path.join(dir, 'backups');
    writeAtomicWithBackup({ filePath: target, content: 'NOVO', backupDir: okBackupDir, tag: 'doc.md' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'NOVO');
    const baks = fs.readdirSync(okBackupDir).filter((f) => f.endsWith('.bak'));
    assert.equal(baks.length, 1);
    assert.equal(fs.readFileSync(path.join(okBackupDir, baks[0]), 'utf8'), 'ORIGINAL');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- R16: parsePorcelain preserva pontos em nomes de branch e trata detached HEAD ----
test('R16: parsePorcelain preserva branches com ponto (release/1.2) e sync bloqueia detached HEAD', async () => {
  assert.equal(parsePorcelain('## release/1.2...origin/release/1.2 [ahead 1]').branch, 'release/1.2');
  assert.equal(parsePorcelain('## feature/foo.bar').branch, 'feature/foo.bar');
  assert.equal(parsePorcelain('## No commits yet on release/2.0').branch, 'release/2.0');
  assert.equal(parsePorcelain('## HEAD (no branch)').branch, '');
  assert.equal(parsePorcelain('## main...origin/main [behind 2]').behind, 2);

  const dir = mkTmp('ai-hud-r16-');
  const wsDir = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(wsDir, '.git'), { recursive: true });
  const gitCalls = [];
  const syncer = createWorkspaceSync({
    dataDir: dir,
    config: {},
    execGit: async (_cwd, args) => {
      gitCalls.push(args);
      if (args[0] === 'status') return { ok: true, code: 0, stdout: '## release/1.2...origin/release/1.2 [ahead 1]\n', stderr: '' };
      if (args[0] === 'remote') return { ok: true, code: 0, stdout: 'https://example.com/ws.git\n', stderr: '' };
      return { ok: true, code: 0, stdout: 'abc123\n', stderr: '' };
    },
  });
  try {
    const res = await syncer.sync();
    assert.equal(res.status, 200);
    assert.ok(gitCalls.some((a) => a[0] === 'rev-parse' && a[2] === 'origin/release/1.2'));
    assert.ok(gitCalls.some((a) => a[0] === 'pull' && a[a.length - 1] === 'release/1.2'));
    assert.ok(gitCalls.some((a) => a[0] === 'push' && a[a.length - 1] === 'release/1.2'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- R17: MCP board_update_status aceita e valida docRef ----
test('R17: MCP board_update_status declara, valida e persiste docRef preservando demais campos', () => {
  const listRes = handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const toolDef = listRes.result.tools.find((t) => t.name === 'board_update_status');
  assert.ok(toolDef.inputSchema.properties.updates.items.properties.docRef, 'schema deve expor docRef');

  const dir = mkTmp('ai-hud-r17-');
  try {
    const wsDir = path.join(dir, '.ai-workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'board.card.json'), JSON.stringify({
      format: 'ai-card',
      version: 1,
      template: 'board',
      title: 'Demo',
      items: [{ id: 'item-1', title: 'Feature X', body: 'Detalhes', status: 'idea', phase: 'Fase 1' }],
    }));

    // Rejeita docRef com traversal
    const bad = updateBoardStatus({ cwd: dir, updates: [{ id: 'item-1', status: 'spec', docRef: '../fora.md' }] });
    assert.ok(bad.error);

    // Aceita docRef válido e preserva campos existentes
    const ok = updateBoardStatus({ cwd: dir, updates: [{ id: 'item-1', status: 'spec', docRef: 'docs/specs/feature-x.md' }] });
    assert.equal(ok.ok, true);
    assert.equal(ok.applied[0].docRef, 'docs/specs/feature-x.md');
    const saved = JSON.parse(fs.readFileSync(path.join(wsDir, 'board.card.json'), 'utf8'));
    assert.equal(saved.items[0].status, 'spec');
    assert.equal(saved.items[0].docRef, 'docs/specs/feature-x.md');
    assert.equal(saved.items[0].phase, 'Fase 1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- R18: evaluateStageAdvance exige evidência da etapa ----
test('R18: evaluateStageAdvance bloqueia avanço sem detalhes, com pergunta/bloqueio, teste falho ou spec ausente', () => {
  // Detalhe indisponível
  assert.equal(evaluateStageAdvance({ currentStatus: 'idea', nextStatus: 'spec', detail: null }).ok, false);
  // Pergunta ao usuário
  assert.equal(evaluateStageAdvance({
    currentStatus: 'idea',
    nextStatus: 'spec',
    detail: { lastReply: 'Você prefere usar SQLite ou PostgreSQL?', files: ['docs/specs/x.md'] },
  }).ok, false);
  // Bloqueio em texto normal
  assert.equal(evaluateStageAdvance({
    currentStatus: 'in-progress',
    nextStatus: 'review',
    detail: { lastReply: 'Bloqueado: falta permissão para acessar o banco.', files: ['src/a.js'] },
  }).ok, false);
  // Spec ausente em Ideia -> Spec
  assert.equal(evaluateStageAdvance({
    currentStatus: 'idea',
    nextStatus: 'spec',
    detail: { lastReply: 'Analisei o problema e anotei ideias gerais.', files: [] },
    target: { id: '1', title: 'T', status: 'idea' },
  }).ok, false);
  // Teste falho
  assert.equal(evaluateStageAdvance({
    currentStatus: 'in-progress',
    nextStatus: 'review',
    detail: { lastReply: 'Implementei a mudança.', files: ['src/a.js'], testRun: { ok: false } },
  }).ok, false);
  // Entrega válida Ideia -> Spec com arquivo .md
  assert.equal(evaluateStageAdvance({
    currentStatus: 'idea',
    nextStatus: 'spec',
    detail: { lastReply: 'Spec criada em docs/specs/nova-feature.md pronta para revisão.', files: ['docs/specs/nova-feature.md'] },
  }).ok, true);
  // Entrega válida Em andamento -> Revisão com arquivos e testes ok
  assert.equal(evaluateStageAdvance({
    currentStatus: 'in-progress',
    nextStatus: 'review',
    detail: { lastReply: 'Implementação concluída com todos os testes passando.', files: ['src/a.js'], testRun: { ok: true } },
  }).ok, true);
});
