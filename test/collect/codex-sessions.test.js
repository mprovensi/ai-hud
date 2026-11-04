const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { codexData, codexWhere } = require('../../src/collect/sources/codex');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}
const ID = '00000000-0000-4000-8000-000000000001';
const CHILD = '00000000-0000-4000-8000-000000000002';
const TS = '2026-10-28T10:00:00.000Z';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-codex-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, lib: { codexData: () => codexData(root) } };
}

function rollout(root, id, records) {
  const dir = path.join(root, 'sessions', '2026', '10', '28');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-28T10-00-00-${id}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify({ timestamp: TS, ...r })).join('\n') + '\n');
  return file;
}

function meta(id, source = 'vscode') {
  return { type: 'session_meta', payload: { id, source, originator: 'codex-tui', cwd: '/project', context_window: 128000 } };
}

function message(role, text) {
  return { type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } };
}

test('Codex atual: lê mensagens response_item, ignora contexto e usa a pasta do Codex informada', (t) => {
  const { root, lib } = fixture(t);
  rollout(root, ID, [meta(ID), message('user', '<environment_context>contexto interno</environment_context>'), message('user', 'Analise o projeto'), message('assistant', 'Análise pronta')]);
  const { sessions } = lib.codexData();
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.prompts, 1);
  assert.equal(s.firstPrompt, 'Analise o projeto');
  assert.equal(s.lastReply, 'Análise pronta');
  assert.equal(s.lastReplyAt, Date.parse(TS));
  assert.equal(s.where, 'terminal'); // codex-tui é o CLI, mesmo com source "vscode"
  assert.equal(s.contextWindow, 128000);
});

test('Codex: não duplica mensagens legadas e mantém mensagens novas em logs mistos', (t) => {
  const { root, lib } = fixture(t);
  rollout(root, ID, [meta(ID), message('user', 'Primeiro'), { type: 'event_msg', payload: { type: 'user_message', message: 'Primeiro' } }, message('user', 'Segundo'), message('assistant', 'Final')]);
  const s = lib.codexData().sessions[0];
  assert.equal(s.prompts, 2);
  assert.equal(s.firstPrompt, 'Primeiro');
  assert.equal(s.lastPrompt, 'Segundo');
});

test('Codex: session_meta herdado não transforma subagente em sessão principal', (t) => {
  const { root, lib } = fixture(t);
  rollout(root, CHILD, [meta(CHILD, { subagent: { thread_spawn: { parent_thread_id: ID } } }), meta(ID), message('user', 'Tarefa herdada')]);
  const s = lib.codexData().sessions[0];
  assert.equal(s.subagent, true);
});

test('Codex: mescla mensagens exclusivas de cada formato sem perder a ordem', (t) => {
  const { root, lib } = fixture(t);
  rollout(root, ID, [meta(ID), message('user', 'A'),
    { type: 'event_msg', payload: { type: 'user_message', message: 'A' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'B' } },
    message('user', 'C')]);
  const s = lib.codexData().sessions[0];
  assert.equal(s.prompts, 3);
  assert.equal(s.firstPrompt, 'A');
  assert.equal(s.lastPrompt, 'C');
});

test('Codex: preserva Continue repetido em turnos distintos e deduplica cada par', (t) => {
  const { root, lib } = fixture(t);
  rollout(root, ID, [meta(ID),
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'first' } },
    message('user', 'Continue'),
    { type: 'event_msg', payload: { type: 'user_message', message: 'Continue' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'second' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Continue' } },
    message('user', 'Continue'),
    { type: 'event_msg', payload: { type: 'task_complete' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'third' } },
    message('user', 'Continue')]);
  const s = lib.codexData().sessions[0];
  assert.equal(s.prompts, 3);
  assert.equal(s.firstPrompt, 'Continue');
  assert.equal(s.lastPrompt, 'Continue');
});

test('Codex: não trata blocos internos como pedidos do usuário', (t) => {
  const { root, lib } = fixture(t);
  const internal = message('user', 'Contexto de uma página aberta');
  internal.payload.internal_chat_message_metadata_passthrough = { turn_id: 'first', content_item_kinds: ['additional_content.codex_apps_open_page'] };
  const actual = message('user', '<exemplo>Texto solicitado pelo usuário</exemplo>');
  actual.payload.internal_chat_message_metadata_passthrough = { turn_id: 'first', content_item_kinds: ['user.text'] };
  rollout(root, ID, [meta(ID), internal, actual]);
  const s = lib.codexData().sessions[0];
  assert.equal(s.prompts, 1);
  assert.equal(s.firstPrompt, '<exemplo>Texto solicitado pelo usuário</exemplo>');
});

test('Codex: exposes each completed turn even when consecutive replies are identical', (t) => {
  const { root, lib } = fixture(t);
  const records = [meta(ID), message('user', 'Fale oi'), message('assistant', 'oi'),
    { type: 'event_msg', payload: { type: 'task_complete' } }];
  rollout(root, ID, records);
  assert.equal(lib.codexData().sessions[0].completedAt, Date.parse(TS));
  const next = '2026-10-28T10:00:05.000Z';
  records.push({ timestamp: next, type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } },
    { ...message('assistant', 'oi'), timestamp: next },
    { timestamp: next, type: 'event_msg', payload: { type: 'task_complete' } });
  rollout(root, ID, records);
  const updated = lib.codexData().sessions[0];
  assert.equal(updated.completedAt, Date.parse(next));
  assert.equal(updated.lastStop, 'end_turn');
  assert.equal(updated.lastReply, 'oi');
});

test('Codex paginado: recupera SQLite sem JSONL e não duplica conversas existentes', { skip: !DatabaseSync }, (t) => {
  const { root, lib } = fixture(t);
  const file = rollout(root, ID, [meta(ID), message('user', 'Mensagem do rollout'), { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } } } }]);
  // O caminho registrado pelo Codex pode ficar fora de sessions/.
  const external = path.join(root, path.basename(file));
  fs.renameSync(file, external);
  const state = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, originator TEXT, cwd TEXT, title TEXT, model TEXT, first_user_message TEXT)');
  const insert = state.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run(ID, external, 1793181600, 1793181660, 'vscode', 'codex-tui', '/project', 'Conversa atual', 'modelo-teste', 'Mensagem do rollout');
  insert.run(CHILD, 'removido.jsonl', 1793181600, 1793181660, 'vscode', 'codex-tui', '/other', 'Conversa migrada', 'modelo-teste', 'Mensagem inicial');
  state.close();
  const history = new DatabaseSync(path.join(root, 'thread_history_1.sqlite'));
  history.exec('CREATE TABLE thread_items (thread_id TEXT, item_type TEXT, item_json TEXT, created_at_ms INTEGER, rollout_ordinal INTEGER); CREATE TABLE thread_turns (thread_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, rollout_ordinal INTEGER)');
  const item = history.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?)');
  item.run(CHILD, 'userMessage', JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: 'Pergunta preservada' }] }), 1793181600000, 0);
  item.run(CHILD, 'agentMessage', JSON.stringify({ type: 'agentMessage', text: 'Resposta preservada' }), 1793181660000, 1);
  history.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)').run(CHILD, 'completed', 1793181600, 1793181660, 0);
  history.close();
  const { sessions } = lib.codexData();
  assert.equal(sessions.length, 2);
  const current = sessions.find((s) => s.id.endsWith(ID));
  assert.equal(current.title, 'Conversa atual');
  assert.equal(current.firstPrompt, 'Mensagem do rollout');
  assert.equal(current.input, 60);
  assert.equal(current.cacheRead, 40);
  assert.equal(current.output, 20);
  assert.equal(current.events.length, 1);
  const migrated = sessions.find((s) => s.id === CHILD);
  assert.equal(migrated.title, 'Conversa migrada');
  assert.equal(migrated.prompts, 1);
  assert.equal(migrated.firstPrompt, 'Pergunta preservada');
  assert.equal(migrated.lastReply, 'Resposta preservada');
  assert.equal(migrated.lastStop, 'end_turn');
  assert.equal(migrated.completedAt, 1793181660000);
  assert.equal(migrated.where, 'terminal');
  assert.equal(migrated.input, 0); // SQLite não informa a distribuição de tokens por turno.
  assert.equal(migrated.events.length, 0);
});

test('Codex: ausência de node:sqlite mantém fallback JSONL sem acessar bancos', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/collect/sources/codex/history-db.js'), 'utf8');
  const sandbox = { module: { exports: {} }, require: (name) => {
    if (name === 'node:sqlite') throw new Error('indisponível');
    if (name === 'fs') return { readdirSync: () => assert.fail('não deve acessar SQLite') };
    return require(name);
  } };
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.module.exports.readCodexHistory('/missing').length, 0);
});

test('Codex: onde a sessão roda vem do originator, não do source "vscode" que todas gravam', () => {
  assert.equal(codexWhere({ originator: 'codex_vscode', source: 'vscode' }), 'vscode');
  assert.equal(codexWhere({ originator: 'codex-tui', source: 'vscode' }), 'terminal');
  assert.equal(codexWhere({ originator: 'Codex Desktop', source: 'vscode' }), 'codex-desktop');
  assert.equal(codexWhere({ source: 'vscode' }), 'vscode');
  assert.equal(codexWhere({ source: 'cli' }), 'terminal');
});
