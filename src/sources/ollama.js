// Todas as conversas do Ollama como sessões: app (db.sqlite), `ollama run` e ollama-proxy; mais as
// continuações respondidas pelo HUD.
const path = require('path');
const os = require('os');
const { createAppReader, appChatToSession } = require('./ollama-app');
const { createProxyReader, proxyToSession } = require('./ollama-proxy');
const { createRunScanner, runCalls, runSessions } = require('./ollama-runs');
const { createOllamaReplies } = require('./ollama-replies');

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

  return {
    start: () => scanner.start(),
    chatSessions,
    runSessions: () => runSessions(scanner.runs(), readCalls(), historyFile),
    proxySessions,
    sessions: () => [...chatSessions(), ...runSessions(scanner.runs(), readCalls(), historyFile), ...proxySessions()],
    reply: replies.reply,
  };
}

module.exports = { createOllamaSource };
