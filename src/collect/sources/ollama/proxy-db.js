// Conversas de qualquer cliente da API do Ollama, gravadas pelo ollama-proxy (pasta ollama-proxy/):
// ele fica na :11434 e grava pergunta + resposta de cada chamada em data/ollama-conversas.sqlite,
// agrupadas por session_id (IP + modelo + primeira pergunta). Só leitura aqui.
const { sqlite, toMs, cut, dbSignature } = require('../common');

const LOCAL_IP = /^(127\.|::1$|::ffff:127\.)/;

function createProxyReader(db) {
  let cache = { sig: '', at: 0, calls: [] };
  return function readProxyCalls() {
    if (!sqlite) return [];
    const sig = dbSignature(db);
    if (!sig) return [];
    if (sig === cache.sig && Date.now() - cache.at < 30e3) return cache.calls;
    let conn;
    try {
      conn = new sqlite.DatabaseSync(db, { readOnly: true });
      // As 40 sessões mais recentes, chamada por chamada
      const calls = conn.prepare(`SELECT id, ts, client_ip, user_agent, endpoint, model, session_id, last_user, response_text,
          prompt_tokens, completion_tokens, client_aborted FROM calls
        WHERE session_id IN (SELECT session_id FROM calls GROUP BY session_id ORDER BY MAX(id) DESC LIMIT 40)
        ORDER BY id`).all();
      // Respostas que o próprio HUD gerou já aparecem como continuação da conversa original
      cache = { sig, at: Date.now(), calls: calls.filter((c) => c.user_agent !== 'ai-hud') };
    } catch { /* banco ocupado: usa a leitura anterior */ } finally { try { conn && conn.close(); } catch {} }
    return cache.calls;
  };
}

function proxyToSession(sid, calls, replies, db) {
  const extra = replies.extra(sid);
  const all = [];
  for (const c of calls) {
    all.push({ role: 'user', content: c.last_user || '', at: toMs(c.ts), model: c.model });
    all.push({ role: 'assistant', content: (c.response_text || '') + (c.client_aborted ? ' [interrompida]' : ''), at: toMs(c.ts), model: c.model });
  }
  for (const m of extra) all.push({ ...m });
  const first = calls[0], last = calls[calls.length - 1];
  const users = all.filter((m) => m.role === 'user' && m.content);
  const answers = all.filter((m) => m.role === 'assistant' && m.content);
  const generating = replies.generating(sid);
  const end = Math.max(...all.map((m) => m.at || 0));
  const ip = String(first.client_ip).replace(/^::ffff:/, '');
  const client = (first.user_agent || '').split(/[\s/]/)[0] || 'cliente';
  return {
    tool: 'Ollama', id: `ollama-api-${sid}`, chatId: sid, file: db, cwd: '', where: 'ollama-api',
    start: new Date(toMs(first.ts)).toISOString(), end: new Date(end).toISOString(),
    mtime: generating ? Date.now() : end,
    lastStop: generating ? '' : 'end_turn',
    project: cut(users[0] ? users[0].content : 'Conversa via API', 60),
    title: `${last.model || 'Ollama'} · ${LOCAL_IP.test(first.client_ip) ? 'este PC' : ip} (${client})`,
    firstPrompt: users[0] ? cut(users[0].content, 120) : '',
    lastPrompt: users.length ? cut(users[users.length - 1].content, 400) : '',
    lastReply: answers.length ? cut(answers[answers.length - 1].content, 4000) : '',
    lastReplyAt: answers.length ? answers[answers.length - 1].at || 0 : 0,
    prompts: users.length, models: new Set(calls.map((c) => c.model).filter(Boolean)), lastTool: generating ? 'gerando' : '',
    input: calls.reduce((a, c) => a + (c.prompt_tokens || 0), 0),
    output: calls.reduce((a, c) => a + (c.completion_tokens || 0), 0) + extra.reduce((a, m) => a + (m.tokens || 0), 0),
    cacheRead: 0, cacheWrite: 0, context: 0, contextWindow: 0, toolCalls: 0, tools: {}, events: [], subagent: false,
    history: all, continued: extra.length > 0,
    generation: answers.length ? answers[answers.length - 1].metrics || null : null,
  };
}

module.exports = { createProxyReader, proxyToSession, LOCAL_IP };
