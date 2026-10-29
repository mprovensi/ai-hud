  // ---- Sessões -------------------------------------------------------------
  var seenReplies = {}, viewedSession = null;
  try {
    var savedSeen = JSON.parse(store('hud.seen') || '{}');
    if (savedSeen && typeof savedSeen === 'object' && !Array.isArray(savedSeen)) seenReplies = savedSeen;
  } catch (e) {}

  function attentionKey(x) { return String(x.completedAt || x.end || 0) + ':' + String(x.prompts || 0); }
  function isSeen(x) { return x.state === 'waiting' && !x.permission && seenReplies[x.id] === attentionKey(x); }

  function rememberViewed(x) {
    // Guarda somente a versão desenhada, sem marcar uma resposta nova ainda não exibida.
    viewedSession = { id: x.id, state: x.state, completedAt: x.completedAt, end: x.end,
      prompts: x.prompts, permission: !!x.permission };
  }

  function acknowledgeViewed() {
    var x = viewedSession;
    viewedSession = null;
    if (!x || x.state !== 'waiting' || x.permission) return;
    seenReplies[x.id] = attentionKey(x);
    delete pings[x.id];
    store('hud.seen', JSON.stringify(seenReplies));
  }

  function badge(x, now) {
    if (x.state === 'permission') return '<span class="badge perm">🔐 permissão · ' + esc(x.permission.tool) + '</span>';
    if (x.state === 'working') return '<span class="badge working"><span class="pulse">●</span> ' + esc(x.lastTool || 'trabalhando') + '</span>';
    if (x.state === 'waiting') return isSeen(x) ? '<span class="badge idle">visto</span>' : '<span class="badge waiting">sua vez · ' + dur(now - x.end) + '</span>';
    if (x.state === 'idle') return '<span class="badge idle">parada ' + dur(now - x.end) + '</span>';
    return '<span class="badge closed">' + when(x.end) + '</span>';
  }

  // Uso do contexto como anel (pizza vazada) com o % no meio; SVG porque o Safari 9 não tem
  // conic-gradient. Detalhe (usado / janela) fica no title e na gaveta da sessão.
  function ctxPie(x) {
    if (!x.context || !x.contextWindow) return '';
    var pct = Math.min(100, x.context / x.contextWindow * 100), r = 15.9155; // circunferência = 100
    return '<span class="pie" title="Contexto ' + Math.round(pct) + '% · ' + k(x.context) + ' de ' + k(x.contextWindow) + '">' +
      '<svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="' + r + '" class="pbg"/>' +
      '<circle cx="18" cy="18" r="' + r + '" class="pfg" stroke="' + levelColor(pct) + '" stroke-dasharray="' + pct.toFixed(1) + ' 100"/></svg>' +
      '<span class="pv">' + Math.round(pct) + '</span></span>';
  }

  function sessRow(x, now) {
    var i = toolIndex(x.tool), meta = [];
    meta.push(x.tool === 'Antigravity' || x.tool === 'Ollama' ? x.prompts + ' pedidos' : k(x.tokens) + ' tokens');
    meta.push(dur(now - x.start));
    return '<button class="sess b' + i + '" data-id="' + esc(x.id) + '">' +
      '<div class="row"><span class="proj ell">' + esc(x.project) + '</span><span class="tool">' + esc(x.tool) + '</span>' +
      '<span class="grow"></span>' + badge(x, now) + '<span class="chev">›</span></div>' +
      (x.title ? '<div class="ttl ell">' + esc(x.title) + '</div>' : '') +
      '<div class="l3 row"><span class="grow">' + meta.join(' · ') + '</span>' + ctxPie(x) + '</div></button>';
  }

  // Cartão da grade principal (a lista de Recentes na gaveta continua em linhas). Só o essencial:
  // IA + projeto + contexto, estado + PC, assunto e uso; o último pedido e o resto ficam na gaveta.
  function sessCard(x, now) {
    var i = toolIndex(x.tool), meta = [];
    meta.push(x.tool === 'Antigravity' || x.tool === 'Ollama' ? x.prompts + ' pedidos' : k(x.tokens) + ' tokens');
    meta.push(dur(now - x.start));
    var ping = pings[x.id] && now - pings[x.id] < 3000 ? ' ping' : '';
    // Cada aviso anima uma vez; redesenhar o painel não reinicia o destaque.
    delete pings[x.id];
    return '<button class="card t' + i + (x.state === 'waiting' && !isSeen(x) ? ' waiting-card' : x.state === 'permission' ? ' perm-card' : x.state === 'closed' ? ' old-card' : '') + ping + '" data-id="' + esc(x.id) + '"><div class="in">' +
      // Ícone da IA antes do nome da sessão; à direita, o anel do contexto
      '<div class="row">' + toolIcon(i) + '<span class="proj ell grow">' + esc(x.project) + '</span>' + ctxPie(x) + '</div>' +
      // Estado; o PC onde a sessão roda fica só na gaveta
      '<div class="sub row">' + badge(x, now) + '<span class="grow"></span>' +
      // Só o símbolo: ✉ resposta na fila, ↩ dá para responder ao vivo
      (x.queued ? '<span class="rflag queued" title="Resposta na fila">✉</span>' : x.listening ? '<span class="rflag" title="Pode responder ao vivo">↩</span>' : '') + '</div>' +
      // Assunto: o título da sessão ou, sem título, o último pedido
      (x.title || x.lastPrompt ? '<div class="ttl ell">' + esc(x.title || x.lastPrompt) + '</div>' : '') +
      lastMsg(x) +
      '<div class="foot meta">' + meta.join(' · ') + '</div></div></button>';
  }

  // Última mensagem numa linha: o seu pedido enquanto a IA trabalha (ou pede permissão);
  // depois, o começo da resposta. Repetir o assunto não ajuda: nesse caso não mostra nada.
  function lastMsg(x) {
    var asking = x.state === 'working' || x.state === 'permission' || !x.lastReply;
    var text = asking ? x.lastPrompt : x.lastReply;
    if (!text || text.toLowerCase() === String(x.title || x.lastPrompt).toLowerCase()) return '';
    return '<div class="lmsg ell' + (asking ? ' me' : '') + '"><span class="who">' + (asking ? 'você' : '↳') + '</span>' + esc(text) + '</div>';
  }

