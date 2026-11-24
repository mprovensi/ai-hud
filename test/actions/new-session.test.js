const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createCapabilities, parseAgyModels } = require('../../src/collect/capabilities');
const { createSessionLauncher } = require('../../src/actions/spawn');
const { createReplies } = require('../../src/actions/reply');
const { createRunning } = require('../../src/actions/running');
const { createOllamaSource } = require('../../src/collect/sources/ollama');
const { createApp } = require('../../src/main');

function fakeSpawn(onSpawn) {
  const calls = [];
  const spawn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.resume = () => {};
    child.stderr = new EventEmitter();
    child.unref = () => { child.unreffed = true; };
    const entry = { exe, args, opts, child };
    calls.push(entry);
    if (onSpawn) onSpawn(entry);
    return child;
  };
  return { spawn, calls };
}

test('parseAgyModels e createCapabilities listam IAs disponíveis, modelos e pastas recentes (somente agy para Gemini)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-caps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mkExe = (n) => { const p = path.join(dir, n); fs.writeFileSync(p, ''); return p; };
  const claudeExe = mkExe('claude');
  const codexExe = mkExe('codex');
  const agyExe = mkExe('agy');

  const parsed = parseAgyModels('Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n');
  assert.deepEqual(parsed, [
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  ]);

  const caps = createCapabilities({
    claudeExe,
    codexExe,
    agyExe,
    ollama: { state: { online: true, models: [] }, installedModels: ['qwen3:8b', 'llama3.2:latest'] },
    showOllama: true,
    exec: (exe, args, opts, cb) => cb(null, 'gemini-4-neon-high\tGemini 4 Neon (High)\n'),
  });
  await caps.refreshAgyModels();
  const res = caps.get([
    { tool: 'Claude Code', cwd: '/proj/a', end: '2026-11-23T12:00:00Z', models: new Set(['claude-sonnet-4-6']) },
    { tool: 'Codex', cwd: '/proj/b', end: '2026-11-23T13:00:00Z', models: new Set(['gpt-5.4']) },
  ], 'MateusNote');

  assert.equal(res.name, 'MateusNote');
  assert.equal(res.online, true);
  assert.deepEqual(res.cwds, ['/proj/b', '/proj/a']);
  assert.ok(res.tools['Claude Code'].models.some((m) => m.id === 'sonnet'));
  assert.ok(res.tools['Claude Code'].models.some((m) => m.id === 'claude-sonnet-4-6'));
  assert.ok(res.tools.Codex.models.some((m) => m.id === 'gpt-5.4'));
  assert.ok(res.tools.Gemini.models.some((m) => m.id === 'gemini-4-neon-high'));
  assert.deepEqual(res.tools.Ollama.models, [{ id: 'qwen3:8b', label: 'qwen3:8b' }, { id: 'llama3.2:latest', label: 'llama3.2:latest' }]);
});

test('createSessionLauncher inicia Claude, Codex, Gemini (agy) com todas as permissões e Ollama no HUD', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-launch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const proj = path.join(dir, 'meu-proj');
  fs.mkdirSync(proj);

  // 1. Claude Code
  const s1 = fakeSpawn();
  const launch1 = createSessionLauncher({ claudeExe: 'claude.exe', spawn: s1.spawn });
  const rClaude = await launch1({ tool: 'Claude Code', model: 'opus', cwd: proj, prompt: 'oi claude' });
  assert.equal(rClaude.status, 200);
  assert.match(rClaude.body.id, /^[0-9a-f-]{36}$/);
  assert.ok(s1.calls[0].args.includes('--dangerously-skip-permissions'));
  assert.ok(s1.calls[0].args.includes('--model'));
  assert.ok(s1.calls[0].args.includes('opus'));
  assert.equal(s1.calls[0].opts.cwd, proj);

  // 2. Codex (captura thread_id do stdout --json)
  const codexUuid = '11111111-2222-4333-8444-555555555555';
  const s2 = fakeSpawn(({ child }) => {
    setTimeout(() => child.stdout.emit('data', JSON.stringify({ type: 'thread.started', thread_id: codexUuid }) + '\n'), 20);
  });
  const launch2 = createSessionLauncher({ codexExe: 'codex.exe', spawn: s2.spawn });
  const rCodex = await launch2({ tool: 'Codex', model: 'gpt-5.4', cwd: proj, prompt: 'oi codex' });
  assert.equal(rCodex.status, 200);
  assert.equal(rCodex.body.id, codexUuid);
  assert.ok(s2.calls[0].args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(s2.calls[0].args.includes('-m'));
  assert.ok(s2.calls[0].args.includes('gpt-5.4'));

  // 3. Gemini (somente agy — captura conversation_id do stream-json)
  const agyUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const s3 = fakeSpawn(({ child }) => {
    setTimeout(() => child.stdout.emit('data', JSON.stringify({ conversation_id: agyUuid }) + '\n'), 20);
  });
  const launch3 = createSessionLauncher({ agyExe: 'agy.exe', spawn: s3.spawn, geminiHome: dir });
  const rGemini = await launch3({ tool: 'Gemini', model: 'gemini-4-neon-high', cwd: proj, prompt: 'oi gemini' });
  assert.equal(rGemini.status, 200);
  assert.equal(rGemini.body.id, agyUuid);
  assert.ok(s3.calls[0].args.includes('--dangerously-skip-permissions'));
  assert.ok(s3.calls[0].args.includes('--model'));
  assert.ok(s3.calls[0].args.includes('gemini-4-neon-high'));

  // 4. Ollama (cria conversa em data/ollama-replies.json e aparece em hudSessions)
  const ollama = createOllamaSource({
    dataDir: dir,
    appDb: path.join(dir, 'missing.sqlite'),
    proxyDb: path.join(dir, 'missing-proxy.sqlite'),
    scanner: { start() {}, runs: () => [] },
    request: (url, opts, cb) => {
      const req = new EventEmitter();
      req.end = () => {
        const res = new EventEmitter();
        cb(res);
        res.emit('data', Buffer.from(JSON.stringify({ message: { content: 'Olá do Ollama!' }, eval_count: 10, prompt_eval_count: 5 })));
        res.emit('end');
      };
      return req;
    },
  });
  const launch4 = createSessionLauncher({ ollamaCreate: ollama.createChat, ollamaUrl: () => 'http://127.0.0.1:11434' });
  const rOllama = await launch4({ tool: 'Ollama', model: 'qwen3:8b', prompt: 'oi ollama' });
  assert.equal(rOllama.status, 200);
  assert.match(rOllama.body.id, /^ollama-hud-/);
  const hudList = ollama.hudSessions();
  assert.equal(hudList.length, 1);
  assert.equal(hudList[0].id, rOllama.body.id);
  assert.equal(hudList[0].lastReply, 'Olá do Ollama!');
  assert.equal(hudList[0].where, 'ollama-hud');
});

test('createReplies continua Claude sem terminal via claude -p --resume e Codex sem TUI via codex exec resume', async () => {
  const s = fakeSpawn();
  const uuid = '00000000-0000-4000-8000-000000000099';
  const reply = createReplies({
    queue: { set() { assert.fail('não deveria enfileirar quando há claudeExe sem hook'); }, listenState: () => null },
    claudeExe: 'claude.exe',
    codexExe: 'codex.exe',
    exec: (exe, args, opts, cb) => cb(new Error('no active codex session')),
    spawn: s.spawn,
    findSession: (pred) => [
      { tool: 'Claude Code', id: uuid, cwd: '/proj' },
      { tool: 'Codex', id: `rollout-2026-${uuid}`, cwd: '/proj' },
    ].find(pred),
  });

  const rc = await reply({ key: uuid, text: 'continue', tool: 'Claude Code' });
  assert.equal(rc.status, 200);
  assert.deepEqual(rc.body, { sent: true });
  assert.deepEqual(s.calls[0].args, ['-p', 'continue', '--resume', uuid, '--dangerously-skip-permissions']);

  const rx = await reply({ key: uuid, text: 'rode os testes', tool: 'Codex' });
  assert.equal(rx.status, 200);
  assert.deepEqual(rx.body, { sent: true });
  assert.deepEqual(s.calls[1].args, ['exec', 'resume', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', uuid, 'rode os testes']);

  // Sessão Codex headless (`codexExec: true`, criada pelo HUD/Workspace) NUNCA deve cair em `codex queue` mesmo que ele retorne exit 0
  let queueCalled = false;
  const replyHeadless = createReplies({
    queue: { set() {}, listenState: () => null },
    codexExe: 'codex.exe',
    exec: (exe, args, opts, cb) => { queueCalled = true; cb(null, '', ''); },
    spawn: s.spawn,
    findSession: () => ({ tool: 'Codex', id: `rollout-2026-${uuid}`, cwd: '/proj', codexExec: true }),
  });
  const rx2 = await replyHeadless({ key: uuid, text: 'segunda mensagem', tool: 'Codex' });
  assert.equal(rx2.status, 200);
  assert.equal(queueCalled, false, 'codex queue não deve ser chamado para sessão codex_exec');
  assert.deepEqual(s.calls[2].args, ['exec', 'resume', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', uuid, 'segunda mensagem']);
});

test('running bloqueia respostas concorrentes na mesma sessão (409) e expõe erro tardio no /api/session', async () => {
  const running = createRunning();
  const s = fakeSpawn();
  const uuid = '00000000-0000-4000-8000-000000000088';
  const reply = createReplies({
    queue: { set() {}, listenState: () => null },
    claudeExe: 'claude.exe',
    spawn: s.spawn,
    running,
    findSession: () => ({ tool: 'Claude Code', id: uuid, cwd: '/proj' }),
  });

  const first = await reply({ key: uuid, text: 'primeira', tool: 'Claude Code' });
  assert.equal(first.status, 200);
  const second = await reply({ key: uuid, text: 'segunda', tool: 'Claude Code' });
  assert.equal(second.status, 409);

  // Quando o processo encerra, libera a trava
  s.calls[0].child.emit('exit', 0);
  assert.equal(running.isBusy(uuid), false);

  // Erro tardio após launch fica disponível em running.lastError
  const sErr = fakeSpawn(({ child }) => {
    setTimeout(() => {
      child.stderr.emit('data', 'erro de autenticacao\n');
      child.emit('exit', 1);
    }, 300);
  });
  const launch = createSessionLauncher({ claudeExe: 'claude.exe', spawn: sErr.spawn, running });
  const started = await launch({ tool: 'Claude Code', prompt: 'oi' });
  assert.equal(started.status, 200);
  await new Promise((r) => setTimeout(r, 360));
  assert.equal(running.lastError(started.body.id), 'erro de autenticacao');
});

test('hub agrega GET /api/capabilities dos peers e repassa POST /api/new prefixando o id com m0:', async (t) => {
  const makeDir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-new-hub-'));
    t.after(() => fs.rmSync(d, { recursive: true, force: true }));
    return d;
  };
  const emptyQuotas = { claude: async () => ({ plan: null, windows: {} }), codex: async () => ({ plan: null, windows: {} }), gemini: async () => ({ plan: null, windows: {} }) };
  const dirPeer = makeDir(), dirHub = makeDir();
  const fakeClaude = path.join(dirPeer, 'claude');
  fs.writeFileSync(fakeClaude, '');
  fs.writeFileSync(path.join(dirPeer, 'config.json'), JSON.stringify({ name: 'Notebook', token: 'tokP', pin: '11111111', ollama: false }));

  const sp = fakeSpawn();
  const peerApp = createApp({
    dataDir: dirPeer,
    sources: { all: () => [] },
    quotaFetchers: emptyQuotas,
    claudeExe: fakeClaude,
    codexExe: '',
    agyExe: '',
    spawn: sp.spawn,
    brands: false,
    log: () => {},
  });
  await new Promise((r) => peerApp.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => peerApp.server.close(r)));
  const peerPort = peerApp.server.address().port;

  fs.writeFileSync(path.join(dirHub, 'config.json'), JSON.stringify({
    name: 'VPS-Oracle', token: 'tokH', pin: '22222222', ollama: false,
    peers: [{ name: 'Notebook', url: `http://127.0.0.1:${peerPort}`, token: 'tokP' }],
  }));
  const hubApp = createApp({
    dataDir: dirHub,
    sources: { all: () => [] },
    quotaFetchers: emptyQuotas,
    claudeExe: '',
    codexExe: '',
    agyExe: '',
    brands: false,
    log: () => {},
  });
  await new Promise((r) => hubApp.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => hubApp.server.close(r)));
  const hubPort = hubApp.server.address().port;

  const caps = await fetch(`http://127.0.0.1:${hubPort}/api/capabilities?t=tokH`).then((r) => r.json());
  assert.equal(caps.machines.length, 2);
  assert.equal(caps.machines[0].name, 'VPS-Oracle');
  assert.deepEqual(Object.keys(caps.machines[0].tools), []);
  assert.equal(caps.machines[1].name, 'Notebook');
  assert.ok(caps.machines[1].tools['Claude Code']);

  const created = await fetch(`http://127.0.0.1:${hubPort}/api/new?t=tokH`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine: 'Notebook', tool: 'Claude Code', model: 'sonnet', prompt: 'teste remoto' }),
  }).then((r) => r.json());
  assert.equal(created.ok, true);
  assert.equal(created.machine, 'Notebook');
  assert.match(created.id, /^m0:[0-9a-f-]{36}$/);
  assert.equal(sp.calls.length, 1);
  assert.ok(sp.calls[0].args.includes('teste remoto'));
});
