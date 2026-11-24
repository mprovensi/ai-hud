const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyProjectDoc,
  extractDocTitle,
  extractItemsFromMarkdown,
  mergeImportedItems,
  toggleMarkdownCheckbox,
} = require('../../src/core/doc-parser');
const {
  buildSpecTemplate,
  buildGoldfishReviewPrompt,
  parseGoldfishReview,
  buildStructureFromDocsPrompt,
  parseStructuredItems,
} = require('../../src/core/egm');

test('doc-parser classifica documentos e extrai checklists/fases com 0 tokens', () => {
  assert.equal(classifyProjectDoc('docs/plano-workspace.md'), 'plan');
  assert.equal(classifyProjectDoc('docs/specs/auth.md'), 'spec');
  assert.equal(classifyProjectDoc('.ai-workspace/reviews/auth.md'), 'review');
  assert.equal(classifyProjectDoc('README.md'), 'doc');

  const md = [
    '# Plano de Evolução',
    '',
    '## Fase 1 — Fundação',
    '- [x] Criar parser puro de docs',
    '- [ ] Salvar quadro em `.ai-workspace/board.card.json`',
    '',
    '## Fase 2 — Interface',
    '- [ ] Substituir aba Notas por Docs & Specs',
  ].join('\n');

  assert.equal(extractDocTitle(md, 'plano.md'), 'Plano de Evolução');
  const parsed = extractItemsFromMarkdown(md, { docPath: 'docs/plano.md' });
  assert.equal(parsed.category, 'plan');
  assert.equal(parsed.items.length, 3);
  assert.equal(parsed.items[0].status, 'done');
  assert.equal(parsed.items[0].phase, 'Fase 1 — Fundação');
  assert.equal(parsed.items[1].status, 'idea');
  assert.match(parsed.items[1].docRef, /^docs\/plano\.md#L/);

  // Deduplicação preserva itens existentes
  const m1 = mergeImportedItems([], parsed.items);
  assert.equal(m1.added.length, 3);
  const m2 = mergeImportedItems(m1.items, parsed.items);
  assert.equal(m2.added.length, 0);
  assert.equal(m2.items.length, 3);

  // Sync reverso Quadro -> Markdown marca [x] e desmarca [ ] preservando o restante
  const t1 = toggleMarkdownCheckbox(md, { lineNo: 5, title: 'Salvar quadro em .ai-workspace/board.card.json', done: true });
  assert.equal(t1.matched, true);
  assert.equal(t1.changed, true);
  assert.match(t1.content, /- \[x\] Salvar quadro em `\.ai-workspace\/board\.card\.json`/);
  assert.match(t1.content, /- \[ \] Substituir aba Notas/);

  const t2 = toggleMarkdownCheckbox(t1.content, { lineNo: 5, title: 'Salvar quadro em .ai-workspace/board.card.json', done: false });
  assert.equal(t2.changed, true);
  assert.match(t2.content, /- \[ \] Salvar quadro em `\.ai-workspace\/board\.card\.json`/);
});

test('egm.js gera template enxuto, prompt Goldfish sem segredos e parseia revisão + estrutura IA', () => {
  const tpl = buildSpecTemplate({ title: 'Login OAuth', summary: 'Permitir login seguro.' });
  assert.match(tpl, /# Login OAuth/);
  assert.match(tpl, /## 5\. Critérios de aceite/);

  const prompt = buildGoldfishReviewPrompt({
    project: 'meu-app',
    docPath: 'docs/specs/login.md',
    docContent: 'Usar token sk-proj-1234567890abcdefghijklmnop na API.',
    pinnedMd: 'Nunca commitar segredos.',
  });
  assert.doesNotMatch(prompt, /sk-proj-1234/);
  assert.match(prompt, /\[REDACTED_TOKEN\]/);

  const rev = parseGoldfishReview(JSON.stringify({
    result: JSON.stringify({
      verdict: 'changes',
      summary: 'Falta definir expiração de sessão.',
      gaps: ['Definir TTL do refresh token'],
      risks: ['CSRF no callback'],
      cuts: ['Remover SSO corporativo da v1'],
    }),
  }), { docPath: 'docs/specs/login.md', engine: 'Claude Code/haiku', usageCompact: '2.4k tok (real)' });
  assert.equal(rev.verdict, 'changes');
  assert.equal(rev.gaps.length, 1);
  assert.match(rev.markdown, /AJUSTES SUGERIDOS/);
  assert.match(rev.markdown, /Definir TTL/);

  const sp = buildStructureFromDocsPrompt({ project: 'meu-app', docs: [{ path: 'docs/ideia.md', content: 'Criar tela X' }] });
  assert.match(sp, /docs\/ideia\.md/);

  const items = parseStructuredItems(JSON.stringify({
    items: [
      { title: 'Implementar tela X', body: 'Com filtro.', status: 'spec', phase: 'MVP', docRef: 'docs/ideia.md' },
    ],
  }));
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'spec');
  assert.equal(items[0].docRef, 'docs/ideia.md');

  // Formato real do Antigravity CLI (`agy --output-format json`): campo `response` com markdown fence
  const agyWrapped = JSON.stringify({
    conversation_id: '5068aeb9-f002-4073-9975-6ba11bade461',
    status: 'SUCCESS',
    response: '```json\n{"items":[{"title":"Tarefa do agy","body":"ok","status":"idea","docRef":"README.md"}]}\n```\n',
    usage: { input_tokens: 9312, output_tokens: 385, cache_read_tokens: 120 },
  });
  const agyItems = parseStructuredItems(agyWrapped);
  assert.equal(agyItems.length, 1);
  assert.equal(agyItems[0].title, 'Tarefa do agy');
});
