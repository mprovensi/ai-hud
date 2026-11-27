// /api/snapshot deste PC: cotas, tokens e cartões das sessões.
// O formato é o contrato com os aparelhos e com os outros PCs (peers): só acrescente campos;
// renomear ou remover quebra versões antigas que ainda estejam rodando.
const { sessionState, compareSessions, base } = require('../core/session');
const { usage } = require('../core/usage');
const { summarizeCosts } = require('../core/pricing');

// quotas: { view(now), burn(now, codexSessions) }; pendingInfo(s, now): resposta na fila, hook escutando,
// permissão aberta; ollamaState(): cartão do Ollama deste PC (null = não mostrar)
function buildSnapshot({ sessions, now, quotas, pendingInfo, ollamaState, remoteMode, ideListen = false, fxState = null, pricingOverrides = null, sharedIndex = null }) {
  const superseded = (sharedIndex && sharedIndex.supersededIds) || null;
  const chainByHead = (sharedIndex && sharedIndex.chainByHeadId) || null;

  const card = (s) => {
    const shared = chainByHead && chainByHead.get(s.id);
    const chain = shared && Array.isArray(shared.chain) && shared.chain.length > 1 ? shared.chain : null;
    const earliestStart = chain
      ? Math.min(...chain.map((x) => Date.parse(x.start) || Infinity))
      : Date.parse(s.start);
    const totalPrompts = chain
      ? chain.reduce((acc, x) => acc + (x.prompts || 0), 0)
      : s.prompts;
    return {
      tool: s.tool, id: s.id, where: s.where || '', project: s.project || base(s.cwd) || '—', title: (chain && chain[0] && (chain[0].title || chain[0].firstPrompt)) || s.title || s.firstPrompt,
      start: Number.isFinite(earliestStart) ? earliestStart : Date.parse(s.start), end: Date.parse(s.end), state: sessionState(s, now), lastTool: s.lastTool,
      completedAt: s.completedAt || 0,
      tokens: s.input + s.output + s.cacheWrite + (s.subTokens || 0), prompts: totalPrompts,
      lastPrompt: (s.lastPrompt || '').replace(/\s+/g, ' ').slice(0, 160),
      // Começo da última resposta, em uma linha e sem marcação de Markdown, para o cartão
      lastReply: (s.lastReply || '').slice(0, 400).replace(/[#*`]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 160),
      lastReplyAt: s.lastReply ? s.lastReplyAt || s.completedAt || 0 : 0,
      context: s.context, contextWindow: s.contextWindow, ...pendingInfo(s, now),
      // O último teste rodado na sessão falhou: o cartão fica vermelho até um teste passar
      testFailed: !!(s.testRun && !s.testRun.ok),
      ...(shared ? {
        sharedSessionId: shared.record.id,
        handoffChain: shared.tools,
      } : {}),
    };
  };
  const cards = sessions
    .filter((s) => !s.subagent && !(superseded && superseded.has(s.id)))
    .map(card)
    .sort((a, b) => b.end - a.end);
  // Uma sessão ouvindo respostas está parada esperando o usuário, mesmo que o log pareça antigo
  for (const v of cards) if (v.listening && v.state === 'closed') v.state = 'waiting';
  // Pedido de permissão aberto: a sessão está parada esperando o usuário
  for (const v of cards) if (v.permission) v.state = 'permission';

  const costSummary = summarizeCosts(sessions, now, pricingOverrides);
  const fx = fxState && typeof fxState === 'object' ? fxState : { usdToBrl: 5.8, source: 'fallback', updatedAt: 0 };

  return {
    // tz: fuso do PC em minutos; os aparelhos mostram os horários no fuso e no relógio do PC
    now, tz: -new Date(now).getTimezoneOffset(), remoteMode, ideListen: !!ideListen, quotas: quotas.view(now),
    ...usage(sessions, now),
    costs: {
      usdToBrl: fx.usdToBrl || 5.8,
      fxSource: fx.source || 'fallback',
      fxUpdatedAt: fx.updatedAt || 0,
      ...costSummary,
    },
    ollama: ollamaState(),
    burn: quotas.burn(now, sessions.filter((s) => s.tool === 'Codex')),
    // Permissões pendentes primeiro; os demais cards seguem a última atividade.
    active: cards.filter((s) => s.state !== 'closed').sort(compareSessions),
    recent: cards.filter((s) => s.state === 'closed').slice(0, 40),
  };
}

module.exports = { buildSnapshot };
