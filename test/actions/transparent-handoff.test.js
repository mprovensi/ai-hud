const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildHandoffPrompt,
  extractHandoffUserNote,
  stitchSharedHistory,
  detectQuotaHandoffSuggestion,
} = require('../../src/core/handoff');
const { createApp } = require('../../src/main');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-trans-handoff-'));

async function listen(app) {
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${app.server.address().port}`;
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

test('stitchSharedHistory costura mensagens entre IAs, insere divisor e oculta boilerplate do handoff', () => {
  const s1 = {
    id: 'gem-1',
    tool: 'Gemini',
    start: '2026-11-27T10:00:00Z',
    end: '2026-11-27T10:05:00Z',
    history: [
      { role: 'user', content: 'Analise as vulnerabilidades do pom.xml', at: 1000 },
      { role: 'assistant', content: 'Encontrei 3 CVEs críticas no Spring Boot.', at: 2000 },
    ],
  };
  const handoffPrompt = `${buildHandoffPrompt({
    filePath: '/tmp/handoff.md',
    session: { ...s1, lastReply: 'Encontrei 3 CVEs críticas.' },
    note: 'Aplique a atualização para Spring Boot 4.1 agora',
    targetTool: 'Codex',
  })}\n\nSessão compartilhada AI HUD: s-20261127-abcd (rev 2).`;

  const parsed = extractHandoffUserNote(handoffPrompt);
  assert.equal(parsed.isHandoffPrompt, true);
  assert.equal(parsed.userText, 'Aplique a atualização para Spring Boot 4.1 agora');

  const s2 = {
    id: 'cdx-2',
    tool: 'Codex',
    start: '2026-11-27T10:06:00Z',
    end: '2026-11-27T10:08:00Z',
    history: [
      { role: 'user', content: handoffPrompt, at: 3000 },
      { role: 'assistant', content: 'Atualizei o pom.xml e rodei mvn test com sucesso.', at: 4000 },
    ],
  };

  const merged = stitchSharedHistory({ chain: [s1, s2] });
  assert.equal(merged.length, 5);
  assert.equal(merged[0].tool, 'Gemini');
  assert.equal(merged[1].tool, 'Gemini');
  assert.equal(merged[2].role, 'handoff');
  assert.equal(merged[2].fromTool, 'Gemini');
  assert.equal(merged[2].toTool, 'Codex');
  assert.equal(merged[3].role, 'user');
  assert.equal(merged[3].content, 'Aplique a atualização para Spring Boot 4.1 agora');
  assert.equal(merged[4].role, 'assistant');
  assert.equal(merged[4].tool, 'Codex');
});

test('detectQuotaHandoffSuggestion detecta cota 100% ou erro de rate limit e sugere IA com menor uso', () => {
  const quotas = {
    gemini: { windows: { pro: { used: 100 } } },
    codex: { windows: { five_hour: { used: 18 } } },
    claude: { windows: { five_hour: { used: 62 } } },
  };
  const s1 = detectQuotaHandoffSuggestion({ tool: 'Gemini', lastReply: 'ok', quotas });
  assert.ok(s1);
  assert.equal(s1.reason, 'quota-full');
  assert.equal(s1.suggestedTool, 'Codex');
  assert.equal(s1.suggestedUsed, 18);

  const s2 = detectQuotaHandoffSuggestion({
    tool: 'Claude Code',
    lastReply: 'Error: HTTP 429 rate limit reached for your account.',
    quotas: { claude: { windows: { five_hour: { used: 50 } } }, codex: { windows: { five_hour: { used: 22 } } } },
  });
  assert.ok(s2);
  assert.equal(s2.reason, 'rate-limit');
  assert.equal(s2.suggestedTool, 'Codex');
});

test('handoff transparente unifica card no snapshot, herda pin/alias e redireciona ID antigo para thread costurada', async () => {
  const dataDir = tmpDir();
  const projectDir = path.join(dataDir, 'proj-trt');
  fs.mkdirSync(projectDir, { recursive: true });
  const token = 'test-token-handoff-123456';
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    name: 'TestPC',
    token,
    pin: '12345678',
    ollama: false,
  }));

  const now = Date.now();
  const sessions = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      tool: 'Gemini',
      where: 'antigravity-cli',
      project: 'proj-trt',
      title: 'Reduzir vulnerabilidades',
      firstPrompt: 'Reduzir vulnerabilidades',
      cwd: projectDir,
      models: new Set(['gemini-2.5-pro']),
      start: new Date(now - 120000).toISOString(),
      end: new Date(now - 30000).toISOString(),
      input: 500, output: 300, cacheRead: 0, cacheWrite: 0,
      context: 800, contextWindow: 100000, prompts: 1, toolCalls: 2,
      tools: { Read: 2 }, files: { [path.join(projectDir, 'pom.xml')]: 1 },
      events: [{ ts: new Date(now - 30000).toISOString(), fresh: 800, cacheRead: 0 }],
      lastPrompt: 'Analise o pom.xml',
      lastReply: 'CVEs mapeadas. Próximo passo: atualizar versão.',
      lastReplyAt: now - 30000,
      history: [
        { role: 'user', content: 'Analise o pom.xml', at: now - 120000 },
        { role: 'assistant', content: 'CVEs mapeadas. Próximo passo: atualizar versão.', at: now - 30000 },
      ],
    },
  ];

  // Simula spawn do Codex que emite o UUID `22222222-...` via stdout JSON
  const fakeCodexId = '22222222-2222-4222-8222-222222222222';
  let capturedPrompt = '';
  const fakeSpawn = (exe, args) => {
    const EventEmitter = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.resume = () => {};
    child.stderr = new EventEmitter();
    child.unref = () => {};
    capturedPrompt = args[args.length - 1] || '';
    process.nextTick(() => {
      child.stdout.emit('data', `${JSON.stringify({ thread_id: fakeCodexId })}\n`);
      // Adiciona a sessão do Codex na lista de sessões carregadas pelo collector
      sessions.push({
        id: fakeCodexId,
        tool: 'Codex',
        where: 'terminal',
        project: 'proj-trt',
        title: capturedPrompt.slice(0, 80),
        firstPrompt: capturedPrompt,
        cwd: projectDir,
        models: new Set(['gpt-5.4']),
        start: new Date(now - 5000).toISOString(),
        end: new Date(now - 1000).toISOString(),
        input: 600, output: 400, cacheRead: 0, cacheWrite: 0,
        context: 1000, contextWindow: 200000, prompts: 1, toolCalls: 1,
        tools: { Edit: 1 }, files: {},
        events: [{ ts: new Date(now - 1000).toISOString(), fresh: 1000, cacheRead: 0 }],
        lastPrompt: capturedPrompt,
        lastReply: 'Atualização aplicada pelo Codex.',
        lastReplyAt: now - 1000,
        history: [
          { role: 'user', content: capturedPrompt, at: now - 4000 },
          { role: 'assistant', content: 'Atualização aplicada pelo Codex.', at: now - 1000 },
        ],
      });
    });
    return child;
  };

  const app = createApp({
    dataDir,
    sources: { all: () => sessions.slice(), start: () => {}, stop: () => {} },
    quotaFetchers: {
      claude: async () => ({ windows: { five_hour: { used: 40 } } }),
      codex: async () => ({ windows: { five_hour: { used: 15 } } }),
      gemini: async () => ({ windows: { pro: { used: 100 } } }),
    },
    codexExe: 'codex',
    spawn: fakeSpawn,
    brands: false,
    log: () => {},
  });
  const baseUrl = await listen(app);

  try {
    // 1. Fixa e renomeia a sessão inicial do Gemini
    const mRes = await reqJson(baseUrl, token, 'POST', '/api/session-meta', {
      id: sessions[0].id,
      pinned: true,
      alias: 'Trivy TRT18',
      group: 'TRT18',
    });
    assert.equal(mRes.status, 200);

    // 2. Executa handoff transparente Gemini -> Codex com instrução do usuário
    const hRes = await reqJson(baseUrl, token, 'POST', '/api/handoff', {
      id: sessions[0].id,
      targetTool: 'Codex',
      targetModel: 'gpt-5.4',
      note: 'Atualize o pom.xml agora',
      cardTitle: 'Reduzir CVEs',
    });
    assert.equal(hRes.status, 200);
    assert.equal(hRes.json.id, fakeCodexId);
    assert.ok(hRes.json.sharedSessionId);

    // 3. Snapshot deve ter APENAS 1 card (Codex ativo), com chain Gemini -> Codex e pin/alias herdados!
    const snapRes = await reqJson(baseUrl, token, 'GET', '/api/snapshot');
    assert.equal(snapRes.status, 200);
    const allCards = [...snapRes.json.active, ...snapRes.json.recent];
    assert.equal(allCards.length, 1, 'card antigo do Gemini deve ficar recolhido atrás do Codex');
    assert.equal(allCards[0].id, fakeCodexId);
    assert.equal(allCards[0].tool, 'Codex');
    assert.equal(allCards[0].pinned, true);
    assert.equal(allCards[0].alias, 'Trivy TRT18');
    assert.equal(allCards[0].group, 'TRT18');
    assert.deepEqual(allCards[0].handoffChain, ['Gemini', 'Codex']);

    // 4. Consultar pelo ID ANTIGO do Gemini redireciona transparentemente para a thread unificada no Codex!
    const detRes = await reqJson(baseUrl, token, 'GET', `/api/session?id=${encodeURIComponent(sessions[0].id)}`);
    assert.equal(detRes.status, 200);
    assert.equal(detRes.json.id, fakeCodexId);
    assert.deepEqual(detRes.json.handoffChain, ['Gemini', 'Codex']);
    assert.ok(detRes.json.history.some((m) => m.role === 'handoff' && m.fromTool === 'Gemini' && m.toTool === 'Codex'));
    assert.ok(detRes.json.history.some((m) => m.role === 'user' && m.content === 'Atualize o pom.xml agora'));
    assert.ok(!detRes.json.history.some((m) => m.content && m.content.includes('Continuação de sessão por Handoff')));
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
