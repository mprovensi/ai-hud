// Todas as conversas do Ollama como sessões: app (db.sqlite), `ollama run` e ollama-proxy; mais as
// continuações respondidas pelo HUD.
const path = require('path');
const os = require('os');
const { createAppReader, appChatToSession } = require('./app');
const { createProxyReader, proxyToSession } = require('./proxy-db');
const { createRunScanner, runCalls, runSessions } = require('./runs');
const { createOllamaReplies } = require('./hud-replies');
const { cut } = require('../common');

function createOllamaSource({
  dataDir,
  appDb = path.join(process.env.LOCALAPPDATA || '', 'Ollama', 'db.sqlite'),
  proxyDb = process.env.AI_HUD_OLLAMA_PROXY_DB || path.join(dataDir, 'ollama-conversas.sqlite'),
  historyFile = path.join(os.homedir(), '.ollama', 'history'),
  scanner = createRunScanner(),
  request,
} = {}) {
  const replies = createOllamaReplies({ file: path.join(dataDir, 'ollama-replies.json'), request });
  const readChats = createAppReader(appDb);
  const readCalls = createProxyReader(proxyDb);

  const chatSessions = () => readChats().map((c) => appChatToSession(c, replies, appDb));

  function proxySessions() {
    const calls = readCalls();
    if (!calls.length) return [];
    // Conversas do app passam pelo proxy também: já aparecem pelo db.sqlite (com título), então ficam de fora
    const appFirst = new Set(readChats().map((c) => {
      const u = c.messages.find((m) => m.role === 'user');
      return u ? String(u.content).trim() : null;
    }).filter(Boolean));
    // Chamadas de um `ollama run` aberto vão para o cartão dele
    const claimed = new Set(scanner.runs().flatMap((r) => runCalls(r, calls).map((c) => c.id)));
    const bySid = new Map();
    for (const c of calls) if (!claimed.has(c.id)) (bySid.get(c.session_id) || bySid.set(c.session_id, []).get(c.session_id)).push(c);
    return [...bySid].filter(([, cs]) => !appFirst.has(String(cs[0].last_user || '').trim()))
      .map(([sid, cs]) => proxyToSession(sid, cs, replies, proxyDb));
  }

  function hudSessions() {
    return replies.hudChats().map((c) => {
      const all = c.messages.map((m) => ({ ...m }));
      const users = all.filter((m) => m.role === 'user');
      const answers = all.filter((m) => m.role === 'assistant' && m.content);
      const last = all[all.length - 1];
      const start = c.createdAt || (all[0] && all[0].at) || Date.now();
      const end = Math.max(start, ...all.map((m) => m.at || 0));
      const generating = !!c.generating;
      const model = c.model || (all.find((m) => m.model) || {}).model || '';
      return {
        tool: 'Ollama', id: `ollama-${c.chatId}`, chatId: c.chatId, file: '', cwd: '', where: 'ollama-hud',
        start: new Date(start).toISOString(), end: new Date(end).toISOString(),
        mtime: generating ? Date.now() : end,
        lastStop: generating || (last && last.role === 'user') ? '' : 'end_turn',
        project: cut(c.title || (users[0] ? users[0].content : '') || 'Conversa do Ollama', 60),
        title: model ? 'modelo ' + model : 'Ollama',
        firstPrompt: users[0] ? cut(users[0].content, 120) : '',
        lastPrompt: users.length ? cut(users[users.length - 1].content, 400) : '',
        lastReply: answers.length ? cut(answers[answers.length - 1].content, 4000) : '',
        lastReplyAt: answers.length ? answers[answers.length - 1].at || 0 : 0,
        prompts: users.length, models: new Set(model ? [model] : []), lastTool: generating ? 'gerando' : '',
        input: 0, output: all.reduce((a, m) => a + (m.tokens || 0), 0), cacheRead: 0, cacheWrite: 0,
        context: 0, contextWindow: 0, toolCalls: 0, tools: {}, files: {}, events: [], subagent: false,
        history: all, continued: true,
        generation: answers.length ? answers[answers.length - 1].metrics || null : null,
      };
    });
  }

  return {
    start: () => scanner.start(),
    chatSessions,
    runSessions: () => runSessions(scanner.runs(), readCalls(), historyFile),
    proxySessions,
    hudSessions,
    sessions: () => [...chatSessions(), ...runSessions(scanner.runs(), readCalls(), historyFile), ...proxySessions(), ...hudSessions()],
    reply: replies.reply,
    createChat: replies.createChat,
  };
}

module.exports = { createOllamaSource };
