const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createApp } = require('../../src/main');
const { readFilePreview } = require('../../src/collect/file-preview');

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
        Cookie: `hud=${token}`,
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

test('readFilePreview respeita contencao de pasta, bloqueia segredos, redacta tokens e detecta binarios', async () => {
  const proj = tmpDir('hud-prev-');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'const token = "sk-proj-1234567890abcdefghijklmnop";\nconsole.log(1);\n');
  fs.writeFileSync(path.join(proj, '.env'), 'SECRET=1234567890\n');
  fs.writeFileSync(path.join(proj, 'img.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

  const ok = await readFilePreview({ cwd: proj, relPath: 'src/app.js', mode: 'content' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.redacted, true);
  assert.doesNotMatch(ok.body.content, /sk-proj-1234/);
  assert.match(ok.body.content, /\[REDACTED_TOKEN\]/);

  const secret = await readFilePreview({ cwd: proj, relPath: '.env', mode: 'content' });
  assert.equal(secret.status, 403);

  const trav = await readFilePreview({ cwd: proj, relPath: '../outside.txt', mode: 'content' });
  assert.equal(trav.status, 400);

  const bin = await readFilePreview({ cwd: proj, relPath: 'img.bin', mode: 'content' });
  assert.equal(bin.status, 200);
  assert.equal(bin.body.binary, true);
});

test('Fase 0 end-to-end: pin de projetos, allowlist remota, stop turno, preview de arquivo e Handoff Cross-IA', async () => {
  const dataDir = tmpDir('hud-p0-data-');
  const projA = tmpDir('hud-p0-proja-');
  const projOther = tmpDir('hud-p0-other-');
  fs.writeFileSync(path.join(projA, 'hello.js'), 'export const x = 42;\n');
  fs.writeFileSync(path.join(projA, '.env'), 'DB_PASSWORD=topsecretvalue\n');
  // Ativa strictRemoteCwd no config inicial
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    token: 'deadbeef0011223344556677',
    pin: '12345678',
    strictRemoteCwd: true,
    name: 'TestPC',
  }));

  const spawned = [];
  const fakeSpawn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.pid = 999999; // PID fictício controlado
    child.stdout = new EventEmitter();
    child.stdout.resume = () => {};
    child.stderr = new EventEmitter();
    child.unref = () => {};
    spawned.push({ exe, args, cwd: opts && opts.cwd, child });
    // Para Codex (`--json`), emite thread_id
    if (args.includes('--json')) {
      setTimeout(() => child.stdout.emit('data', JSON.stringify({ thread_id: '11111111-2222-3333-4444-555555555555' }) + '\n'), 10);
    }
    return child;
  };

  const fakeSession = {
    tool: 'Claude Code',
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    project: 'projA',
    cwd: projA,
    title: 'Tarefa longa',
    models: new Set(['claude-sonnet-4']),
    start: new Date(Date.now() - 60000).toISOString(),
    end: new Date(Date.now() - 2000).toISOString(),
    input: 1000,
    output: 500,
    cacheRead: 0,
    cacheWrite: 0,
    context: 170000,
    contextWindow: 200000,
    prompts: 12,
    toolCalls: 5,
    tools: { Edit: 3 },
    files: { 'hello.js': 2, '.env': 1 },
    lastPrompt: 'Continue a implementação',
    lastReply: 'Arquivo hello.js atualizado.',
    lastReplyAt: Date.now() - 2000,
    events: [],
    history: [
      { role: 'user', content: 'Implemente hello.js', at: Date.now() - 10000 },
      { role: 'assistant', content: 'Arquivo hello.js atualizado.', at: Date.now() - 2000 },
    ],
  };

  // Executáveis reais só precisam existir como arquivo para hasExe()
  const fakeBin = path.join(dataDir, 'fake-cli.cmd');
  fs.writeFileSync(fakeBin, 'echo ok');

  const app = createApp({
    dataDir,
    sources: { all: () => [fakeSession] },
    quotaFetchers: {},
    claudeExe: fakeBin,
    codexExe: fakeBin,
    spawn: fakeSpawn,
    brands: false,
    log: () => {},
  });

  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address();
  const tok = app.config.token;

  try {
    // 1. Pin de projeto e verificação em /api/capabilities
    const pinRes = await reqJson(port, 'POST', '/api/projects/pin', tok, { cwd: projA, pinned: true });
    assert.equal(pinRes.status, 200);
    assert.equal(pinRes.json.ok, true);

    const caps = await reqJson(port, 'GET', '/api/capabilities', tok);
    assert.equal(caps.status, 200);
    assert.equal(caps.json.machines[0].strictRemoteCwd, true);
    assert.equal(caps.json.machines[0].pinned.length, 1);
    assert.equal(caps.json.machines[0].cwds[0].toLowerCase(), projA.toLowerCase());

    // 2. strictRemoteCwd bloqueia pasta desconhecida quando remote=true
    const denied = await reqJson(port, 'POST', '/api/new', tok, {
      tool: 'Claude Code', cwd: projOther, prompt: 'oi', remote: true,
    });
    assert.equal(denied.status, 403);

    // 3. Preview seguro de arquivo da sessão (ok em hello.js, 403 em .env)
    const prevOk = await reqJson(port, 'GET', `/api/fs/preview?id=${fakeSession.id}&path=hello.js&mode=content`, tok);
    assert.equal(prevOk.status, 200);
    assert.match(prevOk.json.content, /export const x = 42/);

    const prevEnv = await reqJson(port, 'GET', `/api/fs/preview?id=${fakeSession.id}&path=.env&mode=content`, tok);
    assert.equal(prevEnv.status, 403);

    // 4. Handoff Cross-IA (Claude -> Codex): salva arquivo em data/workspace/inbox/handoffs e dispara Codex
    const ho = await reqJson(port, 'POST', '/api/handoff', tok, {
      id: fakeSession.id,
      targetTool: 'Codex',
      note: 'Finalizar testes unitários',
    });
    assert.equal(ho.status, 200);
    assert.equal(ho.json.ok, true);
    assert.equal(ho.json.tool, 'Codex');
    assert.equal(ho.json.id, '11111111-2222-3333-4444-555555555555');
    assert.ok(fs.existsSync(ho.json.handoffFile));
    const md = fs.readFileSync(ho.json.handoffFile, 'utf8');
    assert.match(md, /# Handoff — projA/);
    assert.match(md, /Finalizar testes unitários/);

    // 5. POST /api/stop sem processo ativo retorna ok:false sem encerrar a sessão
    const stopNone = await reqJson(port, 'POST', '/api/stop', tok, { id: fakeSession.id });
    assert.equal(stopNone.status, 200);
    assert.equal(stopNone.json.ok, false);
    assert.ok(!fakeSession.endedAt);

    // 6. POST /api/stop em sessão com processo ativo (spawnado pelo handoff) interrompe sem marcar endedAt
    const codexId = ho.json.id;
    const codexSession = { ...fakeSession, id: codexId, tool: 'Codex' };
    // Verifica que o processo está registrado no detail via canStop antes e depois (via close.stop direto no app)
    const { createRunning } = require('../../src/actions/running');
    const { createClose } = require('../../src/actions/close');
    const runReg = createRunning();
    const fakeChild = new EventEmitter();
    fakeChild.pid = 424242;
    runReg.track(codexId, fakeChild);
    assert.equal(runReg.isBusy(codexId), true);
    const killer = createClose({
      platform: 'win32',
      running: runReg,
      exec: (cmd, args, opts, cb) => cb(null, cmd === 'powershell' ? '133000000000000000' : 'OK'),
    });
    const stopped = await killer.stop(codexSession);
    assert.equal(stopped.ok, true);
    assert.equal(runReg.isBusy(codexId), false);
    assert.equal(killer.endedAt(codexId), 0);
  } finally {
    app.server.close();
  }
});
