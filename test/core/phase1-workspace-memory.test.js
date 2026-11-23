const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateCard,
  validateWorkspaceIndex,
  defaultCard,
  defaultWorkspaceIndex,
  slugifyEntity,
} = require('../../src/core/workspace-schema');
const {
  projectSlug,
  enforceLineCap,
  selectDeltaSessions,
  buildSessionDigest,
  parseDreamResponse,
  selectDreamEngine,
  buildBridgeSnippet,
} = require('../../src/core/memory');

test('workspace-schema valida cards (board/research/gallery) e rejeita campos perigosos', () => {
  assert.equal(slugifyEntity('AI HUD — Projeto v2!'), 'ai-hud-projeto-v2');

  const card = defaultCard({ title: 'Sprint 1', template: 'board', summary: 'Plano' });
  card.items.push({
    id: 'task-1',
    title: 'Criar API',
    body: 'Com proteção **409**.',
    status: 'in-progress',
    image: 'media/shot.png',
    url: 'https://example.com/doc',
    sessionRef: { machine: 'VPS-Oracle', id: 'm0:abc-123', tool: 'Claude Code' },
  });
  assert.ok(validateCard(card));

  // ID duplicado falha
  assert.throws(() => validateCard({
    ...card,
    items: [card.items[0], { ...card.items[0] }],
  }), /ID único/);

  // Path traversal na imagem falha
  assert.throws(() => validateCard({
    ...card,
    items: [{ id: 'x', title: 'X', image: '../secret.png' }],
  }), /imagem inválido/);

  // URL javascript: falha
  assert.throws(() => validateCard({
    ...card,
    items: [{ id: 'x', title: 'X', url: 'javascript:alert(1)' }],
  }), /http:\/\/ ou https:\/\//);

  const idx = defaultWorkspaceIndex();
  idx.entities.push({
    id: 'ai-hud',
    title: 'AI HUD',
    description: 'Hub multi-máquina',
    category: 'dev',
    status: 'active',
    pinned: true,
    folder: 'entities/2026-11-23_ai-hud',
    projectBindings: [{ machine: 'Notebook', cwd: 'd:/Projetos/ai-hud' }],
    defaultAgent: 'claude',
    steps: [{ name: 'Quadro', path: 'overview.card.json', viewer: 'card' }],
    created: '2026-11-23',
    updated: '2026-11-23',
  });
  assert.ok(validateWorkspaceIndex(idx));
});

test('memory core: enforceLineCap, selectDeltaSessions, digest sanitizado e parseDreamResponse', () => {
  assert.equal(projectSlug('d:\\Projetos\\ai-hud\\'), 'ai-hud');

  const huge = Array.from({ length: 200 }, (_, i) => `linha ${i + 1}`).join('\n');
  const capped = enforceLineCap(huge, 150);
  assert.ok(capped.trim().split('\n').length <= 150);
  assert.match(capped, /resumido ao limite de 150 linhas/);

  const sessions = [
    { id: 's1', tool: 'Claude Code', project: 'ai-hud', cwd: '/home/u/ai-hud', end: '2026-11-23T10:00:00Z', prompts: 2, history: [{ role: 'user', content: 'Oi sk-proj-1234567890abcdefghijklmnop' }, { role: 'assistant', content: 'Feito' }] },
    { id: 's2', tool: 'Codex', project: 'ai-hud', cwd: '/home/u/ai-hud', end: '2026-11-23T12:00:00Z', prompts: 3, history: [{ role: 'user', content: 'Testes' }, { role: 'assistant', content: 'Passaram' }] },
    { id: 's3', tool: 'Claude Code', project: 'outro', cwd: '/home/u/outro', end: '2026-11-23T13:00:00Z', prompts: 1, lastPrompt: 'x' },
  ];
  const state = { sessions: { s1: { endMs: Date.parse('2026-11-23T10:00:00Z'), turns: 2 } } };
  const delta = selectDeltaSessions(sessions, state, { project: 'ai-hud', cwd: '/home/u/ai-hud' });
  assert.deepEqual(delta.map((s) => s.id), ['s2']);

  const digest = buildSessionDigest(sessions.slice(0, 2));
  assert.doesNotMatch(digest, /sk-proj-1234/);
  assert.match(digest, /\[REDACTED_TOKEN\]/);

  // Parse de resposta dentro de bloco ```json e com redação
  const parsed = parseDreamResponse('```json\n' + JSON.stringify({
    memoryMd: '# AI HUD\nArquitetura limpa.\nToken: sk-ant-secretvalue1234567890abcdef',
    currentStateMd: '# Estado\n- Fase 1',
    decisionsAppend: '- [Codex] Manter zero deps',
    pitfallsAppend: '',
    sessionNoteMd: 'Implementada Fase 0.',
    summary: '+1 decisão',
  }) + '\n```');
  assert.doesNotMatch(parsed.memoryMd, /sk-ant-secretvalue/);
  assert.equal(parsed.summary, '+1 decisão');
});

test('selectDreamEngine respeita prioridade (Ollama custo 0) e teto de cota', () => {
  // 1. Prefere Ollama quando online
  const r1 = selectDreamEngine({
    availableTools: {
      Ollama: { available: true, defaultModel: 'qwen2.5:14b' },
      Gemini: { available: true, defaultModel: '' },
    },
    quotas: { gemini: { windows: { daily: { used: 10 } } } },
  });
  assert.equal(r1.engine, 'Ollama');
  assert.equal(r1.model, 'qwen2.5:14b');

  // 2. Pula Gemini/Codex com cota >= 60% e escolhe Claude com cota 25%
  const r2 = selectDreamEngine({
    availableTools: {
      Ollama: { available: false },
      Gemini: { available: true, defaultModel: '' },
      Codex: { available: true, defaultModel: '' },
      'Claude Code': { available: true, defaultModel: 'haiku' },
    },
    quotas: {
      gemini: { windows: { pro: { used: 80 } } },
      codex: { windows: { five_hour: { used: 65 } } },
      claude: { windows: { five_hour: { used: 25 }, seven_day: { used: 30 } } },
    },
    maxQuotaPct: 60,
  });
  assert.equal(r2.engine, 'Claude Code');

  // 3. Todas acima do teto → adia (engine: null)
  const r3 = selectDreamEngine({
    availableTools: { Ollama: { available: false }, 'Claude Code': { available: true, defaultModel: 'haiku' } },
    quotas: { claude: { windows: { five_hour: { used: 85 } } } },
    maxQuotaPct: 60,
  });
  assert.equal(r3.engine, null);
  assert.match(r3.reason, /85%/);

  assert.match(buildBridgeSnippet('.ai-memory'), /ai-hud-memory-bridge:start/);
});
