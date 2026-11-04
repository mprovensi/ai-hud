// /api/session: tudo o que a gaveta mostra ao tocar numa sessão. Mesmo contrato do snapshot: só acrescentar.
const { sessionState, base } = require('../core/session');

function buildSessionDetail(s, now, pendingInfo) {
  const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return {
    tool: s.tool, id: s.id, title: s.title || s.firstPrompt, project: s.project || base(s.cwd) || '—', cwd: s.cwd,
    models: [...s.models], start: Date.parse(s.start), end: Date.parse(s.end), state: sessionState(s, now), now,
    completedAt: s.completedAt || 0,
    ollamaGeneration: s.tool === 'Ollama' ? s.generation || null : undefined,
    input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite,
    context: s.context, contextWindow: s.contextWindow, prompts: s.prompts, toolCalls: s.toolCalls,
    lastTool: s.lastTool, tools, lastPrompt: s.lastPrompt, lastReply: s.lastReply,
    // Hora da última resposta; sem ela (Codex só no SQLite), o fim do último turno
    lastReplyAt: s.lastReply ? s.lastReplyAt || s.completedAt || 0 : 0,
    subagents: s.subagents || 0, subTokens: s.subTokens || 0, ...pendingInfo(s, now), where: s.where || '',
    turns: s.events.slice(-10).reverse().map((e) => ({ t: Date.parse(e.ts), fresh: e.fresh, cacheRead: e.cacheRead })),
    // Ollama: últimas mensagens da conversa (app) ou comandos digitados (terminal) para a gaveta
    history: s.history ? s.history.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-12)
      .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 2000), at: m.at || 0 })) : null,
  };
}

module.exports = { buildSessionDetail };
