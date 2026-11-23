const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuestions, extractTextQuestions, suggestReplies } = require('../../src/core/questions');

test('normalizeQuestions converte formatos do Claude, Codex e Antigravity para um contrato único', () => {
  const claude = normalizeQuestions({
    questions: [{
      header: 'Layout',
      question: 'Qual layout prefere?',
      multiSelect: false,
      options: [
        { label: 'Abas', description: 'Conversa e Detalhes separados' },
        { label: 'Rolagem', description: 'Tudo em uma página' },
      ],
    }],
  });
  assert.equal(claude.length, 1);
  assert.equal(claude[0].header, 'Layout');
  assert.equal(claude[0].multiSelect, false);
  assert.deepEqual(claude[0].options, [
    { key: '1', label: 'Abas', description: 'Conversa e Detalhes separados' },
    { key: '2', label: 'Rolagem', description: 'Tudo em uma página' },
  ]);

  const codex = normalizeQuestions({
    prompt: 'Como tratar o erro?',
    multi_select: true,
    options: [
      { label: 'A', text: 'Repetir 3 vezes — com backoff exponencial' },
      { label: 'B', text: 'Falhar imediatamente' },
    ],
  });
  assert.equal(codex.length, 1);
  assert.equal(codex[0].multiSelect, true);
  assert.equal(codex[0].options[0].key, 'A');
  assert.equal(codex[0].options[0].label, 'Repetir 3 vezes');
  assert.equal(codex[0].options[0].description, 'com backoff exponencial');

  const antigravity = normalizeQuestions({
    questions: [{
      question: 'Quais módulos incluir?',
      is_multi_select: true,
      options: ['API: rotas REST', 'Web: interface ES5'],
    }],
  });
  assert.equal(antigravity.length, 1);
  assert.equal(antigravity[0].multiSelect, true);
  assert.equal(antigravity[0].options[0].label, 'API');
  assert.equal(antigravity[0].options[0].description, 'rotas REST');
});

test('extractTextQuestions detecta opções numeradas ou por letra quando há pergunta de decisão', () => {
  const reply = [
    'Encontrei duas abordagens possíveis. Qual você prefere?',
    '',
    '1. **Abas no topo** — separa Conversa e Detalhes',
    '2. **Bloco recolhível** — mantém tudo numa rolagem só',
  ].join('\n');
  const qs = extractTextQuestions(reply);
  assert.equal(qs.length, 1);
  assert.match(qs[0].question, /Qual você prefere/);
  assert.equal(qs[0].multiSelect, false);
  assert.equal(qs[0].options.length, 2);
  assert.equal(qs[0].options[0].label, 'Abas no topo');
  assert.equal(qs[0].options[0].description, 'separa Conversa e Detalhes');

  const lettered = [
    'Pode marcar várias opções abaixo:',
    'A) Incluir testes unitários',
    'B) Atualizar README',
    'C) Criar migration',
    'Quais deseja incluir?',
  ].join('\n');
  const qs2 = extractTextQuestions(lettered);
  assert.equal(qs2.length, 1);
  assert.equal(qs2[0].multiSelect, true);
  assert.equal(qs2[0].options.length, 3);
  assert.equal(qs2[0].options[2].key, 'C');
});

test('extractTextQuestions não dispara em listas informativas sem pergunta ou dentro de blocos de código', () => {
  const steps = [
    'Alterações aplicadas com sucesso:',
    '1. Atualizei o parser de sessões.',
    '2. Rodei todos os testes.',
    '3. Subi o commit na branch.',
  ].join('\n');
  assert.deepEqual(extractTextQuestions(steps), []);

  const inCode = [
    'Quer rodar esse exemplo?',
    '```',
    '1. item um',
    '2. item dois',
    '```',
  ].join('\n');
  assert.deepEqual(extractTextQuestions(inCode), []);
});

test('suggestReplies propõe atalhos contextuais conforme a última resposta e estado da sessão', () => {
  assert.deepEqual(suggestReplies({ hasQuestion: true, lastReply: 'Qual opção?' }), []);
  assert.deepEqual(suggestReplies({ testFailed: true, lastReply: 'falhou' }), ['Corrija os testes', 'Explique o erro', 'Rode os testes de novo']);
  assert.deepEqual(suggestReplies({ state: 'working', lastReply: 'lendo arquivos' }), ['Resuma ao terminar', 'Rode os testes depois', 'Pare após este passo']);
  assert.equal(suggestReplies({ lastReply: 'Proposta pronta. Quer que eu implemente?' })[0], 'Sim, implemente');
  assert.equal(suggestReplies({ lastReply: 'Alterações prontas. Quer que eu faça commit e push no GitHub?' })[0], 'Faça o commit');
  assert.equal(suggestReplies({ lastReply: 'Implementado e todos os testes passando (135/135).' })[0], 'Faça o commit');
  assert.equal(suggestReplies({ lastReply: 'Alterações aplicadas com sucesso.' })[0], 'Rode os testes');
  assert.equal(suggestReplies({ lastReply: 'Ocorreu um erro inesperado ao abrir o banco.' })[0], 'Tente outra abordagem');
  assert.equal(suggestReplies({ lastReply: 'Você prefere manter esse nome?' })[0], 'Sim');
  assert.equal(suggestReplies({ lastReply: '' })[0], 'Continue');
});
