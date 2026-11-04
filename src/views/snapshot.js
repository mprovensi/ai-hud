// /api/snapshot deste PC: cotas, tokens e cartões das sessões.
// O formato é o contrato com os aparelhos e com os outros PCs (peers): só acrescente campos;
// renomear ou remover quebra versões antigas que ainda estejam rodando.
const { sessionState, compareSessions, base } = require('../core/session');
const { usage } = require('../core/usage');

// quotas: { view(now), burn(now, codexSessions) }; pendingInfo(s, now): resposta na fila, hook escutando,
// permissão aberta; ollamaState(): cartão do Ollama deste PC (null = não mostrar)
function buildSnapshot({ sessions, now, quotas, pendingInfo, ollamaState, remoteMode }) {
  const card = (s) => ({
    tool: s.tool, id: s.id, project: s.project || base(s.cwd) || '—', title: s.title || s.firstPrompt,
    start: Date.parse(s.start), end: Date.parse(s.end), state: sessionState(s, now), lastTool: s.lastTool,
    completedAt: s.completedAt || 0,
    tokens: s.input + s.output + s.cacheWrite + (s.subTokens || 0), prompts: s.prompts,
    lastPrompt: (s.lastPrompt || '').replace(/\s+/g, ' ').slice(0, 160),
    // Começo da última resposta, em uma linha e sem marcação de Markdown, para o cartão
    lastReply: (s.lastReply || '').slice(0, 400).replace(/[#*`]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 160),
    lastReplyAt: s.lastReply ? s.lastReplyAt || s.completedAt || 0 : 0,
    context: s.context, contextWindow: s.contextWindow, ...pendingInfo(s, now),
  });
  const cards = sessions.filter((s) => !s.subagent).map(card).sort((a, b) => b.end - a.end);
  // Uma sessão ouvindo respostas está parada esperando o usuário, mesmo que o log pareça antigo
  for (const v of cards) if (v.listening && v.state === 'closed') v.state = 'waiting';
  // Pedido de permissão aberto: a sessão está parada esperando o usuário
  for (const v of cards) if (v.permission) v.state = 'permission';

  return {
    // tz: fuso do PC em minutos; os aparelhos mostram os horários no fuso e no relógio do PC
    now, tz: -new Date(now).getTimezoneOffset(), remoteMode, quotas: quotas.view(now),
    ...usage(sessions, now), ollama: ollamaState(),
    burn: quotas.burn(now, sessions.filter((s) => s.tool === 'Codex')),
    // Permissões pendentes primeiro; os demais cards seguem a última atividade.
    active: cards.filter((s) => s.state !== 'closed').sort(compareSessions),
    recent: cards.filter((s) => s.state === 'closed').slice(0, 40),
  };
}

module.exports = { buildSnapshot };
