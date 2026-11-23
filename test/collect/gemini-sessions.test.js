const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { geminiSessions, geminiCliSessions, antigravitySessions } = require('../../src/collect/sources/gemini');
const { sqlite } = require('../../src/collect/sources/common');
const { buildSessionDetail } = require('../../src/views/session-detail');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hud-gemini-'));
}

test('Gemini CLI lê sessões .jsonl com $set, mensagens incrementais, tokens, testes e ignora boot vazio', () => {
  const root = tmpRoot();
  const projDir = path.join(root, 'tmp', 'meu-app');
  const chatsDir = path.join(projDir, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, '.project_root'), 'D:\\Projetos\\meu-app\n');

  // Sessão vazia (só <session_context>) deve ser ignorada
  fs.writeFileSync(path.join(chatsDir, 'session-2026-11-19T10-00-vazia.jsonl'), [
    JSON.stringify({ sessionId: 'a2a-server', startTime: '2026-11-19T10:00:00Z', lastUpdated: '2026-11-19T10:00:01Z' }),
    JSON.stringify({ $set: { messages: [{ id: 'm0', type: 'user', timestamp: '2026-11-19T10:00:00Z', content: [{ text: '<session_context>\ncontexto\n</session_context>' }] }] } }),
  ].join('\n'));

  // Sessão completa com $set + mensagem incremental + toolCall de teste falhando
  const t1 = '2026-11-19T11:00:00Z';
  const t2 = '2026-11-19T11:01:00Z';
  const t3 = '2026-11-19T11:02:00Z';
  fs.writeFileSync(path.join(chatsDir, 'session-2026-11-19T11-00-real.jsonl'), [
    JSON.stringify({ sessionId: 'real-1', startTime: t1, lastUpdated: t2, summary: 'Corrigir API' }),
    JSON.stringify({
      $set: {
        messages: [
          { id: 'ctx', type: 'user', timestamp: t1, content: [{ text: '<session_context>setup</session_context>' }] },
          { id: 'u1', type: 'user', timestamp: t1, content: [{ text: 'rode os testes' }] },
          {
            id: 'g1', type: 'gemini', model: 'gemini-2.5-pro', timestamp: t2,
            content: [{ text: 'Rodei os testes.' }],
            tokens: { input: 1000, cached: 600, output: 200, thoughts: 50, total: 1250 },
            toolCalls: [
              { id: 'tc0', name: 'replace', status: 'success', args: { file_path: 'D:\\Projetos\\meu-app\\src\\api.js' } },
              { id: 'tc1', name: 'run_shell_command', status: 'error', args: { command: 'npm test' }, resultDisplay: 'not ok 1 - falhou\n# fail 1' },
            ],
          },
        ],
      },
    }),
    // Mensagem incremental atualizando a conversa
    JSON.stringify({
      id: 'g2', type: 'gemini', model: 'gemini-2.5-pro', timestamp: t3,
      content: [{ text: 'Tudo corrigido.' }],
      tokens: { input: 2000, cached: 1500, output: 300, thoughts: 100 },
    }),
  ].join('\n'));

  // Sessão legada .json
  fs.writeFileSync(path.join(chatsDir, 'session-2026-11-18T09-00-legado.json'), JSON.stringify({
    sessionId: 'leg-1', startTime: '2026-11-18T09:00:00Z', lastUpdated: '2026-11-18T09:05:00Z',
    messages: [
      { id: 'u1', type: 'user', timestamp: '2026-11-18T09:00:00Z', content: 'olá' },
      { id: 'g1', type: 'gemini', model: 'gemini-2.5-flash', timestamp: '2026-11-18T09:05:00Z', content: 'oi!', tokens: { input: 500, cached: 0, output: 100 } },
    ],
  }));

  const list = geminiCliSessions(root);
  assert.equal(list.length, 2);
  const real = list.find((s) => s.id === 'session-2026-11-19T11-00-real');
  assert.ok(real);
  assert.equal(real.tool, 'Gemini');
  assert.equal(real.where, 'gemini-cli');
  assert.equal(real.cwd, 'D:\\Projetos\\meu-app');
  assert.equal(real.title, 'Corrigir API');
  assert.equal(real.prompts, 1);
  assert.equal(real.lastPrompt, 'rode os testes');
  assert.equal(real.lastReply, 'Tudo corrigido.');
  assert.equal(real.lastStop, 'end_turn');
  assert.equal(real.input, 900);      // (1000-600) + (2000-1500)
  assert.equal(real.cacheRead, 2100); // 600 + 1500
  assert.equal(real.output, 650);     // (200+50) + (300+100)
  assert.equal(real.context, 2000);
  assert.equal(real.contextWindow, 1e6);
  assert.equal(real.events.length, 2);
  assert.equal(real.events[0].fresh, 650);  // 400 + 250
  assert.equal(real.events[1].fresh, 900);  // 500 + 400
  assert.equal(real.toolCalls, 2);
  assert.equal(real.testRun.ok, false);
  assert.deepEqual(real.files, { 'src/api.js': 1 });
  assert.deepEqual([...real.models], ['gemini-2.5-pro']);

  const legacy = list.find((s) => s.id === 'session-2026-11-18T09-00-legado');
  assert.ok(legacy);
  assert.equal(legacy.input, 500);
  assert.equal(legacy.output, 100);
});

test('Antigravity lê transcript.jsonl, enriquece com conversation_summaries.db, soma subagentes e mantém history.jsonl', () => {
  const root = tmpRoot();
  const parentId = 'conv-parent-1';
  const childId = 'conv-child-1';

  // Transcript do pai
  const pLog = path.join(root, 'antigravity', 'brain', parentId, '.system_generated', 'logs');
  fs.mkdirSync(pLog, { recursive: true });
  fs.writeFileSync(path.join(pLog, 'transcript.jsonl'), [
    JSON.stringify({
      step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-23T13:00:00Z',
      content: '<USER_REQUEST>\nadicione gemini no hud\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3 Pro (High).\n</USER_SETTINGS_CHANGE>',
    }),
    JSON.stringify({
      step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-23T13:00:05Z',
      input_tokens: 10000, cache_read_tokens: 0, output_tokens: 200,
      tool_calls: [
        { name: 'edit_file', args: { Path: '"d:\\Projetos\\ai-hud\\web\\js\\app.js"' } },
        { name: 'write_file', args: { Path: '"C:\\Users\\x\\.gemini\\antigravity\\brain\\conv-parent-1\\plan.md"', ArtifactMetadata: '{}' } },
        { name: 'run_command', args: { CommandLine: '"npm test"' } },
      ],
    }),
    JSON.stringify({
      step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-23T13:00:10Z',
      content: 'Command exited with code 0.\n# pass 10\n# fail 0',
    }),
    JSON.stringify({
      step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-23T13:00:20Z',
      input_tokens: 2000, cache_read_tokens: 10500, output_tokens: 300,
      content: 'Pronto, Gemini adicionado ao HUD.',
    }),
  ].join('\n'));

  // Transcript de subagente
  const cLog = path.join(root, 'antigravity', 'brain', childId, '.system_generated', 'logs');
  fs.mkdirSync(cLog, { recursive: true });
  fs.writeFileSync(path.join(cLog, 'transcript.jsonl'), [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-23T13:00:06Z', content: 'pesquise logs' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-23T13:00:09Z', input_tokens: 500, cache_read_tokens: 1000, output_tokens: 150, content: 'feito' }),
  ].join('\n'));

  // Banco conversation_summaries.db
  if (sqlite) {
    const db = new sqlite.DatabaseSync(path.join(root, 'antigravity', 'conversation_summaries.db'));
    db.exec(`CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY, title text, preview text, last_modified_time text,
      workspace_uris text, status text, source text, parent_conversation_id text, nesting_depth integer
    )`);
    const ins = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run(parentId, 'Integrar Gemini no AI HUD', '', '2026-11-23 13:00:20+00:00', '["file:///d%3A/Projetos/ai-hud"]', 'CASCADE_RUN_STATUS_IDLE', '', '', 0);
    ins.run(childId, 'Pesquisa', '', '2026-11-23 13:00:09+00:00', '', 'CASCADE_RUN_STATUS_IDLE', '', parentId, 1);
    db.close();
  }

  // Conversa legada só no history.jsonl
  const cliDir = path.join(root, 'antigravity-cli');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, 'history.jsonl'), JSON.stringify({
    conversationId: 'legacy-cli-1',
    timestamp: Date.parse('2026-11-20T12:00:00Z'),
    workspace: 'D:\\Projetos\\antigo',
    display: 'pergunta antiga no CLI',
  }) + '\n');

  // Conversa criada pelo CLI `agy` (~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl)
  const cliConvId = '4ca8a1ac-59ec-4bd2-a7f5-49ffd3238c1b';
  const cliLog = path.join(root, 'antigravity-cli', 'brain', cliConvId, '.system_generated', 'logs');
  fs.mkdirSync(cliLog, { recursive: true });
  fs.writeFileSync(path.join(cliLog, 'transcript.jsonl'), [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-23T20:06:50Z', content: '<USER_REQUEST>\nTeste CLI\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-23T20:06:55Z', model: 'gemini-4-neon-high', input_tokens: 100, output_tokens: 20, content: 'Respondido pelo agy!' }),
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'antigravity-cli', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(root, 'antigravity-cli', 'cache', 'conversation_metadata.json'), JSON.stringify({
    conversations: { [cliConvId]: { summary: { Title: 'Sessão agy CLI', WorkspaceURIs: ['file:///d%3A/Projetos/ai-hud'] } } },
  }));

  const all = antigravitySessions(root);
  const cliSess = all.find((s) => s.id === cliConvId);
  assert.ok(cliSess);
  assert.equal(cliSess.where, 'antigravity-cli');
  assert.equal(cliSess.title, 'Sessão agy CLI');
  assert.equal(cliSess.cwd, 'd:/Projetos/ai-hud');
  assert.equal(cliSess.lastReply, 'Respondido pelo agy!');
  assert.ok(cliSess.models.has('gemini-4-neon-high'));
  const parent = all.find((s) => s.id === parentId);
  assert.ok(parent);
  assert.equal(parent.tool, 'Gemini');
  assert.equal(parent.where, 'antigravity');
  assert.equal(parent.prompts, 1);
  assert.equal(parent.lastPrompt, 'adicione gemini no hud');
  assert.equal(parent.lastReply, 'Pronto, Gemini adicionado ao HUD.');
  assert.equal(parent.lastStop, 'end_turn');
  assert.equal(parent.input, 12000);
  assert.equal(parent.cacheRead, 10500);
  assert.equal(parent.output, 500);
  assert.equal(parent.context, 12500);
  assert.equal(parent.contextWindow, 1e6);
  assert.equal(parent.testRun.ok, true);
  assert.deepEqual([...parent.models], ['Gemini 3 Pro (High)']);
  if (sqlite) {
    assert.equal(parent.cwd, 'd:/Projetos/ai-hud');
    assert.equal(parent.title, 'Integrar Gemini no AI HUD');
    assert.equal(parent.subagents, 1);
    assert.equal(parent.subTokens, 650); // 500 + 150
    const detail = buildSessionDetail(parent, Date.parse('2026-11-23T13:01:00Z'), () => ({}));
    assert.deepEqual(detail.files, [['web/js/app.js', 1]]);
  }

  const legacy = all.find((s) => s.id === 'legacy-cli-1');
  assert.ok(legacy);
  assert.equal(legacy.tool, 'Gemini');
  assert.equal(legacy.where, 'antigravity-cli');
  assert.equal(legacy.cwd, 'D:\\Projetos\\antigo');
  assert.equal(legacy.prompts, 1);

  // geminiSessions une CLI + Antigravity
  assert.equal(geminiSessions(root).length, all.length);
});
