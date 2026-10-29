const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createOllamaSource } = require('../src/sources/ollama');

// Bancos de verdade numa pasta temporária: o do ollama-proxy e o do app do Ollama
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-proxy-'));
  const proxy = new DatabaseSync(path.join(dir, 'conversas.sqlite'));
  proxy.exec(`CREATE TABLE calls (id INTEGER PRIMARY KEY, ts TEXT, client_ip TEXT, user_agent TEXT, endpoint TEXT, model TEXT,
    session_id TEXT, last_user TEXT, response_text TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, client_aborted INTEGER)`);
  const add = proxy.prepare('INSERT INTO calls (ts, client_ip, user_agent, endpoint, model, session_id, last_user, response_text, prompt_tokens, completion_tokens, client_aborted) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  add.run('2026-10-28T15:59:09.000', '192.168.5.229', 'node', '/api/chat', 'gpt-oss:20b', 'aaa', 'Explique LLMs', 'São modelos...', 80, 900, 0);
  add.run('2026-10-28T16:00:00.000', '192.168.5.229', 'node', '/api/chat', 'gpt-oss:20b', 'aaa', 'Resuma', 'Resumo', 1000, 50, 1);
  add.run('2026-10-28T16:01:00.000', '127.0.0.1', 'ai-hud', '/api/chat', 'gpt-oss:20b', 'hud', 'Continue', 'ok', 1, 1, 0);
  add.run('2026-10-28T16:02:00.000', '127.0.0.1', 'ollama/0.40.11 (amd64 windows)', '/api/chat', 'qwen3.5', 'app', 'oi', 'olá', 5, 5, 0);
  proxy.close();
  fs.mkdirSync(path.join(dir, 'Ollama'));
  const app = new DatabaseSync(path.join(dir, 'Ollama', 'db.sqlite'));
  app.exec(`CREATE TABLE chats (id TEXT, title TEXT, created_at TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, chat_id TEXT, role TEXT, content TEXT, model_name TEXT, created_at TEXT, updated_at TEXT);
    INSERT INTO chats VALUES ('c1', 'Saudação', '2026-10-28T16:02:00Z');
    INSERT INTO messages (chat_id, role, content, model_name, created_at) VALUES ('c1', 'user', 'oi', 'qwen3.5', '2026-10-28T16:02:00Z');`);
  app.close();
  return dir;
}

function load(dir) {
  return createOllamaSource({ dataDir: dir, appDb: path.join(dir, 'Ollama', 'db.sqlite'), proxyDb: path.join(dir, 'conversas.sqlite'),
    scanner: { runs: () => [], start() {} } });
}

test('conversas do ollama-proxy viram sessões, sem as do app nem as do próprio HUD', () => {
  const sessions = load(setup()).proxySessions();
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.id, 'ollama-api-aaa');
  assert.equal(s.where, 'ollama-api');
  assert.equal(s.title, 'gpt-oss:20b · 192.168.5.229 (node)');
  assert.equal(s.project, 'Explique LLMs');
  assert.equal(s.prompts, 2);
  assert.equal(s.lastPrompt, 'Resuma');
  assert.equal(s.lastReply, 'Resumo [interrompida]');
  assert.equal(s.input, 1080);
  assert.equal(s.output, 950);
  assert.equal(s.history.map((m) => m.role).join(), 'user,assistant,user,assistant');
});
