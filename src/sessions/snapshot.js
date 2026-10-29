// O que os aparelhos recebem: /api/snapshot (cotas, tokens, cartões) e /api/session (detalhe).
// O formato destes objetos é o contrato com os aparelhos e com os outros PCs (peers): só acrescente
// campos; renomear ou remover quebra versões antigas que ainda estejam rodando.
const { replyKey } = require('../actions/replies');
const { compareSessions } = require('../peers');

const ACTIVE_MS = 2 * 60 * 1000;   // log mexido há menos disso: trabalhando
const RECENT_MS = 30 * 60 * 1000;  // até isso: sessão aberta, ociosa
const base = (p) => (p ? p.split(/[\\/]/).filter(Boolean).pop() : '');

// Atividade pelo último registro do log: no Windows a data de modificação de um arquivo
// mantido aberto (Codex retomando uma sessão antiga) só atualiza quando ele é fechado
function sessionState(s, now) {
  const idle = now - Math.max(s.mtime || 0, Date.parse(s.end) || 0);
  if (idle < ACTIVE_MS && s.lastStop !== 'end_turn') return 'working';
  if (idle >= RECENT_MS) return 'closed';
  // Terminou o turno e está parada: é a vez do usuário
  return s.lastStop === 'end_turn' ? 'waiting' : 'idle';
}

// Tokens por hora nas últimas 24h, por dia nos últimos 7 dias e de hoje (inclui subagentes: é uso real)
function usage(all, now) {
  const hourMs = 3600e3;
  const firstHour = Math.floor(now / hourMs) * hourMs - 23 * hourMs;
  const hours = Array.from({ length: 24 }, (_, i) => ({ t: firstHour + i * hourMs, 'Claude Code': 0, Codex: 0 }));
  const today = { 'Claude Code': { fresh: 0, cacheRead: 0 }, Codex: { fresh: 0, cacheRead: 0 } };
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  // Meia-noite local de cada dia
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(midnight); d.setDate(d.getDate() - 6 + i);
    return { t: d.getTime(), 'Claude Code': 0, Codex: 0 };
  });
  const sessionsToday = { 'Claude Code': 0, Codex: 0, Antigravity: 0, Ollama: 0 };
  for (const s of all) {
    if (!s.subagent && Date.parse(s.end) >= midnight.getTime()) sessionsToday[s.tool]++;
    for (const e of s.events) {
      const t = Date.parse(e.ts);
      const i = Math.floor((t - firstHour) / hourMs);
      if (i >= 0 && i < 24) hours[i][s.tool] += e.fresh;
      if (t >= midnight.getTime()) { today[s.tool].fresh += e.fresh; today[s.tool].cacheRead += e.cacheRead; }
      for (let d = days.length - 1; d >= 0; d--) if (t >= days[d].t) { days[d][s.tool] += e.fresh; break; }
    }
  }
  return { hours, days, today, sessionsToday };
}

function createSnapshots({ sources, quotas, replies, permissions, ollamaState = () => null }) {
  function replyInfo(s, now) {
    const key = replyKey(s);
    return { key, listening: replies.listenState(key, now), queued: replies.queued(key), permission: permissions.pendingFor(key, now) };
  }

  const find = (id) => sources.all().find((x) => x.id === id && !x.subagent);

  function snapshot() {
    const now = Date.now();
    if (quotas.expired(now) && quotas.sinceRefresh(now) > 60e3) quotas.refreshAll();
    const all = sources.all();

    const view = (s) => ({
      tool: s.tool, id: s.id, project: s.project || base(s.cwd) || '—', title: s.title || s.firstPrompt,
      start: Date.parse(s.start), end: Date.parse(s.end), state: sessionState(s, now), lastTool: s.lastTool,
      completedAt: s.completedAt || 0,
      tokens: s.input + s.output + s.cacheWrite + (s.subTokens || 0), prompts: s.prompts,
      lastPrompt: (s.lastPrompt || '').replace(/\s+/g, ' ').slice(0, 160),
      // Começo da última resposta, em uma linha e sem marcação de Markdown, para o cartão
      lastReply: (s.lastReply || '').slice(0, 400).replace(/[#*`]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 160),
      lastReplyAt: s.lastReply ? s.lastReplyAt || s.completedAt || 0 : 0,
      context: s.context, contextWindow: s.contextWindow, ...replyInfo(s, now),
    });
    const sessions = all.filter((s) => !s.subagent).map(view).sort((a, b) => b.end - a.end);
    // Uma sessão ouvindo respostas está parada esperando o usuário, mesmo que o log pareça antigo
    for (const v of sessions) if (v.listening && v.state === 'closed') v.state = 'waiting';
    // Pedido de permissão aberto: a sessão está parada esperando o usuário
    for (const v of sessions) if (v.permission) v.state = 'permission';

    return {
      // tz: fuso do PC em minutos; os aparelhos mostram os horários no fuso e no relógio do PC
      now, tz: -new Date(now).getTimezoneOffset(), remoteMode: permissions.remoteMode, quotas: quotas.view(now),
      ...usage(all, now), ollama: ollamaState(),
      burn: quotas.burn(now, all.filter((s) => s.tool === 'Codex')),
      // Permissões pendentes primeiro; os demais cards seguem a última atividade.
      active: sessions.filter((s) => s.state !== 'closed').sort(compareSessions),
      recent: sessions.filter((s) => s.state === 'closed').slice(0, 40),
    };
  }

  // Tudo o que a tela de detalhe mostra ao tocar numa sessão
  function detail(id) {
    const s = find(id);
    if (!s) return null;
    const now = Date.now();
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
      subagents: s.subagents || 0, subTokens: s.subTokens || 0, ...replyInfo(s, now), where: s.where || '',
      turns: s.events.slice(-10).reverse().map((e) => ({ t: Date.parse(e.ts), fresh: e.fresh, cacheRead: e.cacheRead })),
      // Ollama: últimas mensagens da conversa (app) ou comandos digitados (terminal) para a gaveta
      history: s.history ? s.history.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-12)
        .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 2000), at: m.at || 0 })) : null,
    };
  }

  // Alguma sessão trabalhando agora? (as cotas são lidas com mais frequência)
  const busy = (now) => sources.all().some((s) => !s.subagent && sessionState(s, now) === 'working');

  return { snapshot, detail, find, busy };
}

module.exports = { createSnapshots, sessionState };
