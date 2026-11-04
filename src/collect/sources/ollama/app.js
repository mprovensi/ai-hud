// Conversas do app do Ollama (Windows): lê o banco do app (%LOCALAPPDATA%\Ollama\db.sqlite) SÓ PARA LEITURA.
const { sqlite, toMs, cut, dbSignature } = require('../common');

// Lê chats e mensagens; relê só quando o banco (ou o WAL) mudou, e no máximo a cada 30 s de qualquer jeito
function createAppReader(db) {
  let cache = { sig: '', at: 0, chats: [] };
  return function readChats() {
    if (!sqlite) return [];
    const sig = dbSignature(db);
    if (!sig) return [];
    if (sig === cache.sig && Date.now() - cache.at < 30e3) return cache.chats;
    let conn;
    try {
      conn = new sqlite.DatabaseSync(db, { readOnly: true });
      const chats = conn.prepare('SELECT id, title, created_at FROM chats').all();
      const msgs = conn.prepare('SELECT chat_id, role, content, model_name, created_at, updated_at FROM messages ORDER BY id').all();
      const byChat = {};
      for (const m of msgs) (byChat[m.chat_id] = byChat[m.chat_id] || []).push(m);
      cache = { sig, at: Date.now(), chats: chats.map((c) => ({ ...c, messages: byChat[c.id] || [] })) };
    } catch { /* banco ocupado: usa a leitura anterior */ } finally { try { conn && conn.close(); } catch {} }
    return cache.chats;
  };
}

// Uma conversa do app (+ continuação do HUD) no mesmo formato das sessões do Claude/Codex
function appChatToSession(c, replies, db) {
  const extra = replies.extra(c.id);
  const all = c.messages.map((m) => ({ role: m.role, content: m.content || '', at: toMs(m.updated_at || m.created_at), model: m.model_name }))
    .concat(extra.map((m) => ({ ...m })));
  const users = all.filter((m) => m.role === 'user');
  const answers = all.filter((m) => m.role === 'assistant' && m.content);
  const last = all[all.length - 1];
  const end = Math.max(toMs(c.created_at), ...all.map((m) => m.at || 0));
  const generating = replies.generating(c.id);
  const model = [...all].reverse().find((m) => m.model);
  return {
    tool: 'Ollama', id: `ollama-${c.id}`, chatId: c.id, file: db, cwd: '', where: 'ollama-app',
    start: new Date(toMs(c.created_at) || end).toISOString(), end: new Date(end).toISOString(),
    mtime: generating ? Date.now() : end,
    lastStop: generating || (last && last.role === 'user') ? '' : 'end_turn',
    // Nome do cartão = título da conversa; linha de baixo = modelo
    project: cut(c.title || (users[0] ? users[0].content : '') || 'Conversa do Ollama', 60),
    title: model ? 'modelo ' + model.model : 'Ollama',
    firstPrompt: users[0] ? cut(users[0].content, 120) : '',
    lastPrompt: users.length ? cut(users[users.length - 1].content, 400) : '',
    lastReply: answers.length ? cut(answers[answers.length - 1].content, 4000) : '',
    lastReplyAt: answers.length ? answers[answers.length - 1].at || 0 : 0,
    prompts: users.length, models: new Set(model ? [model.model] : []), lastTool: generating ? 'gerando' : '',
    input: 0, output: extra.reduce((a, m) => a + (m.tokens || 0), 0), cacheRead: 0, cacheWrite: 0,
    context: 0, contextWindow: 0, toolCalls: 0, tools: {}, events: [], subagent: false,
    history: all, continued: extra.length > 0,
    generation: answers.length ? answers[answers.length - 1].metrics || null : null,
  };
}

module.exports = { createAppReader, appChatToSession };
