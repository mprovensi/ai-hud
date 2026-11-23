const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePath,
  isWithinRoot,
  isSafeRelativePath,
  isSecretPath,
  toSafeRelPath,
  isCwdAllowed,
} = require('../../src/core/path-guard');
const { redactSecrets } = require('../../src/core/redact');
const { handoffFileName, buildHandoffMarkdown, buildHandoffPrompt } = require('../../src/core/handoff');

test('path-guard bloqueia path traversal, prefixo irmao e arquivos sensiveis', () => {
  assert.equal(normalizePath('d:/Projetos/ai-hud/', 'win32'), 'd:\\Projetos\\ai-hud');
  assert.equal(normalizePath('/home/ubuntu/ai-hud/', 'linux'), '/home/ubuntu/ai-hud');

  assert.equal(isWithinRoot('/home/u/proj', '/home/u/proj/src/a.js', 'linux'), true);
  assert.equal(isWithinRoot('/home/u/proj', '/home/u/proj2/src/a.js', 'linux'), false);
  assert.equal(isWithinRoot('D:\\Projetos\\ai-hud', 'd:\\projetos\\ai-hud\\src\\main.js', 'win32'), true);

  assert.equal(isSafeRelativePath('src/main.js'), true);
  assert.equal(isSafeRelativePath('../secret.txt'), false);
  assert.equal(isSafeRelativePath('a/../../b'), false);
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRelativePath('C:\\Windows\\win.ini'), false);
  assert.equal(isSafeRelativePath('ok.txt\0.jpg'), false);

  assert.equal(isSecretPath('.env'), true);
  assert.equal(isSecretPath('backend/.env.production'), true);
  assert.equal(isSecretPath('.env.example'), false);
  assert.equal(isSecretPath('certs/server.key'), true);
  assert.equal(isSecretPath('oracle-vps.pem'), true);
  assert.equal(isSecretPath('.ssh/id_ed25519'), true);
  assert.equal(isSecretPath('data/config.json'), true);
  assert.equal(isSecretPath('src/infra/config.js'), false);

  assert.equal(toSafeRelPath('d:/Projetos/ai-hud/src/main.js', 'd:\\Projetos\\ai-hud', 'win32'), 'src/main.js');
  assert.equal(toSafeRelPath('../fora.js', '/home/u/proj', 'linux'), null);
});

test('isCwdAllowed impoe allowlist quando strict=true e libera tudo quando strict=false', () => {
  assert.equal(isCwdAllowed('/qualquer/lugar', { strict: false, platform: 'linux' }).ok, true);
  assert.equal(isCwdAllowed('/qualquer/lugar', {
    strict: true,
    home: '/home/u',
    knownCwds: ['/home/u/proj-a'],
    allowedRoots: ['/home/u/work'],
    platform: 'linux',
  }).ok, false);
  assert.equal(isCwdAllowed('/home/u/proj-a', {
    strict: true,
    knownCwds: ['/home/u/proj-a'],
    platform: 'linux',
  }).ok, true);
  assert.equal(isCwdAllowed('/home/u/work/sub/app', {
    strict: true,
    allowedRoots: ['/home/u/work'],
    platform: 'linux',
  }).ok, true);
});

test('redactSecrets oculta chaves, tokens e credenciais preservando placeholders', () => {
  const sample = [
    'OPENAI_API_KEY=sk-proj-1234567890abcdefghijklmnop',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def',
    'url=https://admin:SuperSecret123@example.com/api',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----',
    'SAFE_PLACEHOLDER=${API_KEY}',
    'PASSWORD=changeme_local',
  ].join('\n');

  const res = redactSecrets(sample);
  assert.ok(res.count >= 4);
  assert.doesNotMatch(res.text, /sk-proj-1234/);
  assert.doesNotMatch(res.text, /eyJhbGciOiJI/);
  assert.doesNotMatch(res.text, /SuperSecret123/);
  assert.doesNotMatch(res.text, /abc123/);
  assert.match(res.text, /\[REDACTED_PRIVATE_KEY\]/);
  assert.match(res.text, /SAFE_PLACEHOLDER=\$\{API_KEY\}/);
});

test('handoff gera nome limpo, Markdown estruturado sanitizado e prompt de continuacao Cross-IA', () => {
  const name = handoffFileName('AI HUD (Prod)', 'abcdef12-3456-7890-abcd-ef1234567890', Date.UTC(2026, 10, 23));
  assert.equal(name, '2026-11-23-ai-hud-prod-34567890.md');

  const session = {
    id: 'sess-12345678',
    tool: 'Claude Code',
    project: 'ai-hud',
    cwd: '/home/ubuntu/ai-hud',
    title: 'Implementar Fase 0',
    models: new Set(['claude-sonnet-4']),
    context: 160000,
    contextWindow: 200000,
    prompts: 14,
    files: { 'src/main.js': 2 },
    testRun: { ok: false, command: 'npm test', summary: '1 falha' },
    history: [
      { role: 'user', content: 'Use token sk-ant-secretvalue1234567890abcdef' },
      { role: 'assistant', content: 'Implementei a rota e os testes.' },
    ],
    lastReply: 'Implementei a rota e os testes.',
  };

  const md = buildHandoffMarkdown(session, {
    targetTool: 'Codex',
    note: 'Corrija o teste que falhou',
    gitBranch: 'refactor/estrutura',
    gitStatus: 'M src/main.js',
    now: Date.UTC(2026, 10, 23, 18, 0, 0),
  });
  assert.match(md, /^# Handoff — ai-hud/);
  assert.match(md, /Continuação Cross-IA em:\*\* Codex/);
  assert.match(md, /Branch Git:\*\* `refactor\/estrutura`/);
  assert.match(md, /Corrija o teste que falhou/);
  assert.doesNotMatch(md, /sk-ant-secretvalue/);

  const prompt = buildHandoffPrompt({
    filePath: '/home/ubuntu/ai-hud/data/workspace/inbox/handoffs/2026-11-23-ai-hud-12345678.md',
    session,
    note: 'Corrija o teste que falhou',
    targetTool: 'Codex',
  });
  assert.match(prompt, /vindo de Claude Code/);
  assert.match(prompt, /Leia primeiro o arquivo de handoff/);
  assert.match(prompt, /Corrija o teste que falhou/);
});
