(function () {
  var TOOLS = ['Claude Code', 'Codex', 'Antigravity', 'Ollama'];
  var COLORS = ['#e08a66', '#5fb8a4', '#7d9bf0', '#b39ddb'];
  var token = (/[?&]t=([a-f0-9]+)/.exec(location.search) || [])[1] || '';
  var lastOk = 0, snap = null, view = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  // Horários pelo relógio e pelo fuso do PC, não do aparelho (tablet com hora ou fuso errado):
  // skew = hora do PC − hora do aparelho; tzMs = fuso do PC. Ambos chegam em cada snapshot.
  var skew = 0, tzMs = null;
  function serverNow() { return new Date().getTime() + skew; }
  function wall(t) {
    if (tzMs == null) { var d = new Date(t); return { h: d.getHours(), mi: d.getMinutes(), day: d.getDate(), mon: d.getMonth(), wd: d.getDay(), key: d.toDateString() }; }
    var u = new Date(t + tzMs);
    return { h: u.getUTCHours(), mi: u.getUTCMinutes(), day: u.getUTCDate(), mon: u.getUTCMonth(), wd: u.getUTCDay(),
      key: u.getUTCFullYear() + '-' + u.getUTCMonth() + '-' + u.getUTCDate() };
  }
  var WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  function hm(t) { var w = wall(t); return pad(w.h) + ':' + pad(w.mi); }
  function when(t) {
    var w = wall(t), now = serverNow();
    if (w.key === wall(now).key) return 'às ' + hm(t);
    return (w.key === wall(now - 864e5).key ? 'ontem ' : pad(w.day) + '/' + pad(w.mon + 1) + ' ') + hm(t);
  }
  function k(n) { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : '' + n; }
  function dur(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return m + 'min';
    var h = Math.floor(m / 60);
    return h < 24 ? h + 'h' + pad(m % 60) : Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }
  function levelColor(p) { return p >= 80 ? '#e87070' : p >= 50 ? '#e0b45a' : '#5fb8a4'; }
  // Preferências do aparelho; localStorage pode falhar (aba privada no iOS)
  function store(key, val) { try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) {} }
  function toolIndex(t) { for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i] === t) return i; return 0; }

  // ---- Cotas ---------------------------------------------------------------
  // Só avisa quando preocupa (ritmo para passar de 80% ou acabar antes do reset); no ritmo, nada
  function paceText(w, now) {
    var p = w.pace;
    if (w.used >= 100) return '<span class="hi">esgotada</span>';
    if (!p) return '';
    if (p.runsOutIn != null) return '<span class="hi">▲ acaba em ' + dur(p.runsOutIn) + '</span>';
    if (p.projected != null && p.projected >= 80) return '<span class="warn">~' + p.projected + '% no reset</span>';
    return '';
  }

  // Uma linha: rótulo curto, barra (com a marca do ritmo esperado) e %; embaixo, o reset e o aviso
  function gauge(label, title, w, now) {
    if (!w) return '';
    var used = Math.max(0, Math.min(100, w.used)), mark = w.pace ? w.pace.expected : null;
    return '<div class="gauge" title="' + title + '"><div class="row"><span class="lbl">' + label + '</span>' +
      '<div class="track grow"><div class="fill" style="width:' + used + '%;background:' + levelColor(used) + '"></div>' +
      (mark != null ? '<div class="mark" style="left:' + Math.min(99, mark) + '%"></div>' : '') + '</div>' +
      '<span class="pct">' + Math.round(w.used) + '%</span></div>' +
      '<div class="foot row"><span class="muted grow" title="reinicia em ' + dur(w.resetsAt - now) + '">↻ ' + resetAt(w.resetsAt) + '</span>' +
      paceText(w, now) + '</div></div>';
  }

  // Horário do reset: só a hora se for hoje, "amanhã 09:00" ou o dia da semana ("sex 15:59")
  function resetAt(t) {
    var w = wall(t), now = serverNow();
    if (w.key === wall(now).key) return hm(t);
    if (w.key === wall(now + 864e5).key) return 'amanhã ' + hm(t);
    return WEEKDAYS[w.wd] + ' ' + hm(t);
  }

  // Ícones das extensões do VS Code, servidos pelo HUD já na cor de referência de cada IA
  // Ícone do app do Ollama (servido pelo HUD, pintado de lilás por filtro); se o PC principal não tiver
  // o app instalado, a imagem falha e é escondida
  function ollamaIcon() {
    return '<img class="brand ollama-ico" src="/brand-ollama.png" alt="" onerror="this.style.display=&quot;none&quot;">';
  }
  function toolIcon(idx) {
    if (idx === 3) return ollamaIcon();
    return idx < 2 ? brandIcon(idx) : '<span class="dot c2"></span>';
  }
  function brandIcon(idx) {
    return '<img class="brand" src="/brand-' + (idx ? 'codex' : 'claude') + '.svg" alt="">';
  }

  function quotaPanel(id, name, idx, q, now, used) {
    var html = '<div class="qhead row"' + (q && q.plan ? ' title="Plano ' + esc(q.plan) + '"' : '') + '>' + brandIcon(idx) + '<span class="name">' + name + '</span>' +
      '<span class="grow"></span><span class="tokens" title="Tokens usados hoje">' + k(used) + ' <small>hoje</small></span><span class="chev">›</span></div>';
    if (!q) html += '<div class="empty">lendo…</div>';
    else {
      var w = q.windows || {};
      if (w.five_hour || w.seven_day) html += gauge('5h', 'Janela de 5 horas', w.five_hour, now) + gauge('7d', 'Semana', w.seven_day, now);
      else if (!q.error) html += '<div class="empty">sem cota de plano</div>';
      if (q.error) html += '<div class="qerr">⚠ ' + esc(q.error) + '</div>';
    }
    $(id).innerHTML = html;
  }

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

  // ---- Burn-up da janela de 5h ----------------------------------------------
  // Linha cheia: % usado ao longo da janela. Tracejada: ritmo atual até o reset (ou até 100%).
  // only: 'claude' ou 'codex' desenha só essa IA (gaveta de uso); sem ele, as duas
  function burnChart(s, only) {
    var box = $('burn');
    if (!box) return;
    var W = box.clientWidth, H = box.clientHeight, names = only ? [only] : ['claude', 'codex'], i, j;
    var b = s.burn || {}, x0 = Infinity, x1 = -Infinity;
    for (i = 0; i < names.length; i++) if (b[names[i]]) { x0 = Math.min(x0, b[names[i]].start); x1 = Math.max(x1, b[names[i]].end); }
    if (x0 === Infinity || !W || !H) { box.innerHTML = '<div class="empty">sem dados da janela</div>'; $('burnAxis').innerHTML = ''; return; }
    var L = 40, T = 8, R = 6, B = 6, now = s.now;
    function X(t) { return (L + (t - x0) / (x1 - x0) * (W - L - R)).toFixed(1); }
    function Y(p) { return (T + (1 - Math.min(100, p) / 100) * (H - T - B)).toFixed(1); }
    var svg = '<svg width="' + W + '" height="' + H + '">';
    var grid = [[0, '0%'], [50, '50%'], [100, '100%']];
    for (i = 0; i < grid.length; i++) {
      svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(grid[i][0]) + '" y2="' + Y(grid[i][0]) + '" stroke="' + (grid[i][0] === 100 ? '#6b3a3a' : '#2c2c29') + '" stroke-width="1"' + (grid[i][0] === 100 ? ' stroke-dasharray="4 4"' : '') + '/>' +
        '<text x="' + (L - 6) + '" y="' + (+Y(grid[i][0]) + 5) + '" text-anchor="end">' + grid[i][1] + '</text>';
    }
    svg += '<line x1="' + X(now) + '" x2="' + X(now) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="#5c5c57" stroke-dasharray="3 4"/>';
    for (i = 0; i < names.length; i++) {
      var d = b[names[i]];
      if (!d) continue;
      var pts = '';
      for (j = 0; j < d.points.length; j++) pts += X(d.points[j][0]) + ',' + Y(d.points[j][1]) + ' ';
      svg += '<polyline points="' + pts + '" fill="none" stroke="' + COLORS[names[i] === 'codex' ? 1 : 0] + '" stroke-width="3" stroke-linejoin="round"/>';
      var tEnd = d.runsOutIn != null ? now + d.runsOutIn : d.end, pEnd = d.runsOutIn != null ? 100 : d.projected;
      if (pEnd != null) {
        svg += '<line x1="' + X(now) + '" y1="' + Y(d.used) + '" x2="' + X(tEnd) + '" y2="' + Y(pEnd) + '" stroke="' + COLORS[names[i] === 'codex' ? 1 : 0] + '" stroke-width="2" stroke-dasharray="6 5" opacity=".8"/>';
        if (d.runsOutIn != null) svg += '<circle cx="' + X(tEnd) + '" cy="' + Y(100) + '" r="5" fill="#e87070"/>';
      }
      svg += '<circle cx="' + X(Math.min(now, d.end)) + '" cy="' + Y(d.used) + '" r="4" fill="' + COLORS[names[i] === 'codex' ? 1 : 0] + '"/>';
    }
    box.innerHTML = svg + '</svg>';
    $('burnAxis').innerHTML = '<span>' + hm(x0) + '</span><span>agora ' + hm(now) + '</span><span>' + hm(x1) + '</span>';
  }

  // ---- Estatísticas (gaveta #estatisticas) ---------------------------------
  // Barras empilhadas Claude/Codex; `label` põe o total em cima de cada barra; `tool` mostra só essa IA
  function bars(rows, label, tool) {
    var max = 1, html = '', j;
    function a_(r) { return tool === 'Codex' ? 0 : r['Claude Code']; }
    function b_(r) { return tool === 'Claude Code' ? 0 : r.Codex; }
    for (j = 0; j < rows.length; j++) max = Math.max(max, a_(rows[j]) + b_(rows[j]));
    var scale = label ? 82 : 100; // espaço para o rótulo
    for (j = 0; j < rows.length; j++) {
      var a = a_(rows[j]), b = b_(rows[j]);
      html += '<div class="bar">' +
        (a ? '<div style="height:' + (a / max * scale) + '%;background:' + COLORS[0] + '"></div>' : '') +
        (b ? '<div style="height:' + (b / max * scale) + '%;background:' + COLORS[1] + '"></div>' : '') +
        (label && a + b ? '<div class="val">' + k(a + b) + '</div>' : '') + '</div>';
    }
    return { html: html, max: max };
  }

  // ---- Uso de uma IA (gaveta #uso=claude / #uso=codex, aberta pelo cartão de uso) ----------
  var USAGE = { claude: { name: 'Claude', tool: 'Claude Code', idx: 0 }, codex: { name: 'Codex', tool: 'Codex', idx: 1 } };
  var usageName = null;

  function usageRow(label, value) { return '<div class="dl"><span>' + esc(label) + '</span><span>' + value + '</span></div>'; }

  // Uma janela de cota: %, barra com a marca do ritmo uniforme, uma frase com o que importa e os detalhes
  function usageWindow(title, w, now) {
    if (!w) return '';
    var p = w.pace || {}, used = Math.max(0, Math.min(100, w.used)), sum;
    if (w.used >= 100) sum = '<span class="hi">Cota esgotada.</span> Volta ' + when(w.resetsAt) + '.';
    else if (p.runsOutIn != null) sum = '<span class="hi">No ritmo atual, acaba ' + when(now + p.runsOutIn) + '</span>, ' +
      dur(w.resetsAt - now - p.runsOutIn) + ' antes do reset.';
    else if (p.projected != null) sum = 'No ritmo atual, chega a <b>~' + p.projected + '%</b> no reset.';
    else sum = '<span class="muted">Ainda sem dados para projetar o ritmo.</span>';
    var html = '<div class="panel"><div class="row"><h2 class="grow" style="margin:0">' + title + '</h2><span class="big">' + Math.round(w.used) + '%</span></div>' +
      '<div class="track utrack"><div class="fill" style="width:' + used + '%;background:' + levelColor(used) + '"></div>' +
      (p.expected != null ? '<div class="mark" style="left:' + Math.min(99, p.expected) + '%"></div>' : '') + '</div>' +
      '<div class="usum">' + sum + '</div>';
    html += usageRow('Reinicia', 'em ' + dur(w.resetsAt - now) + ' · ' + when(w.resetsAt));
    html += usageRow('Disponível', Math.max(0, 100 - Math.round(w.used)) + '%');
    if (p.expected != null) {
      var diff = Math.round(w.used - p.expected);
      html += usageRow('Ritmo uniforme até agora', p.expected + '% ' + (diff > 0 ? '<span class="warn">(' + diff + ' pts acima)</span>'
        : diff < 0 ? '<span class="lo">(' + (-diff) + ' pts abaixo)</span>' : '(no ritmo)'));
    }
    if (p.basis && p.projected != null) html += usageRow('Projeção calculada com', p.basis === 'recent' ? 'o uso da última hora' : 'a média desde o início da janela');
    return html + '</div>';
  }

  function renderUsage() {
    if (!snap || !USAGE[usageName]) return;
    var s = snap, u = USAGE[usageName], q = s.quotas[usageName], now = s.now, i;
    var html = head(brandIcon(u.idx) + u.name + (q && q.plan ? ' <small class="muted">' + esc(String(q.plan).toUpperCase()) + '</small>' : ''),
      q && q.at ? 'cota lida ' + when(q.at) : '');
    if (q && q.error) html += '<div class="panel"><div class="qerr" style="margin:0">⚠ ' + esc(q.error) + '</div></div>';
    var w = q && q.windows || {};
    if (!q) html += '<p class="empty">lendo…</p>';
    else if (!w.five_hour && !w.seven_day) html += '<p class="empty">Sem cota de plano.</p>';
    html += usageWindow('Janela de 5 horas', w.five_hour, now) + usageWindow('Semana', w.seven_day, now);
    if (q && q.resetCredits) html += '<div class="panel">' + usageRow('Resets de cota disponíveis', q.resetCredits) + '</div>';
    // Janela de 5h ao longo do tempo, só desta IA
    if (s.burn && s.burn[usageName]) {
      html += '<div class="panel"><h2>Janela de 5h · uso e projeção</h2><div class="burnbox" id="burn"></div><div class="axis" id="burnAxis"></div>' +
        '<div class="legend"><span>━ real</span><span>╌ ritmo atual</span><span>│ agora</span><span style="color:#e87070">● cota acaba</span></div></div>';
    }
    var t = s.today[u.tool] || { fresh: 0, cacheRead: 0 }, n = s.sessionsToday[u.tool] || 0;
    var h = bars(s.hours, false, u.tool);
    html += '<div class="panel"><h2>Hoje</h2><div class="today"><div class="tday"><div class="big">' + k(t.fresh) + '</div><small>tokens novos</small></div>' +
      '<div class="tday"><div class="big">' + k(t.cacheRead) + '</div><small>lidos do cache</small></div>' +
      '<div class="tday"><div class="big">' + n + '</div><small>' + (n === 1 ? 'sessão' : 'sessões') + '</small></div></div>' +
      '<div class="chart">' + h.html + '</div><div class="axis"><span>24h atrás</span><span>pico ' + k(h.max) + '/h</span><span>agora</span></div></div>';
    var d = bars(s.days, true, u.tool), labels = '';
    for (i = 0; i < s.days.length; i++) labels += '<span style="-webkit-flex:1;flex:1;text-align:center">' + (i === s.days.length - 1 ? 'hoje' : WEEKDAYS[wall(s.days[i].t).wd]) + '</span>';
    html += '<div class="panel"><h2>Últimos 7 dias · tokens novos</h2><div class="chart days">' + d.html + '</div><div class="axis">' + labels + '</div></div>';
    // Sessões desta IA abertas agora (toque abre a sessão)
    var mine = [];
    for (i = 0; i < s.active.length; i++) if (s.active[i].tool === u.tool) mine.push(s.active[i]);
    html += '<div class="panel"><h2>Sessões ativas · ' + mine.length + '</h2>';
    for (i = 0; i < mine.length; i++) html += sessRow(mine[i], now);
    if (!mine.length) html += '<div class="empty">Nenhuma sessão ativa agora.</div>';
    setOverlay(html + '</div>');
    burnChart(s, usageName);
  }

  function renderStats() {
    if (!snap) return;
    var s = snap, names = ['Claude Code', 'Codex'], i, html = head('Estatísticas');
    html += '<div class="panel"><h2>Janela de 5h · uso e projeção</h2><div class="burnbox" id="burn"></div><div class="axis" id="burnAxis"></div>' +
      '<div class="legend"><span><span class="dot c0"></span>Claude</span><span><span class="dot c1"></span>Codex</span>' +
      '<span>━ real</span><span>╌ ritmo atual</span><span style="color:#e87070">● cota acaba</span></div></div>';
    html += '<div class="panel"><h2>Hoje · tokens novos</h2><div class="today">';
    for (i = 0; i < names.length; i++) {
      html += '<div class="tday"><span class="dot c' + i + '"></span>' + (i ? 'Codex' : 'Claude') +
        '<div class="big">' + k(s.today[names[i]].fresh) + '</div><small>+ ' + k(s.today[names[i]].cacheRead) + ' do cache · ' +
        s.sessionsToday[names[i]] + (s.sessionsToday[names[i]] === 1 ? ' sessão' : ' sessões') + '</small></div>';
    }
    var h = bars(s.hours, false);
    html += '</div><div class="chart">' + h.html + '</div><div class="axis"><span>24h atrás</span><span>pico ' + k(h.max) + '/h</span><span>agora</span></div></div>';
    var d = bars(s.days, true), labels = '';
    for (i = 0; i < s.days.length; i++) labels += '<span style="-webkit-flex:1;flex:1;text-align:center">' + (i === s.days.length - 1 ? 'hoje' : WEEKDAYS[wall(s.days[i].t).wd]) + '</span>';
    html += '<div class="panel"><h2>Últimos 7 dias · tokens novos</h2><div class="chart days">' + d.html + '</div><div class="axis">' + labels + '</div></div>';
    setOverlay(html);
    burnChart(s);
  }

  // ---- Alertas: bipe + aviso quando uma sessão passa a esperar por você ou a cota de 5h está acabando ----
  var prevStates = null, prevCompleted = null, pings = {}, quotaAlerted = {}, audio = null;
  var soundOn = store('hud.sound') !== '0';

  // O iOS só libera áudio depois de um toque do usuário: o primeiro toque cria o contexto
  function unlockAudio() {
    if (audio) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audio = new Ctx();
    var b = audio.createBuffer(1, 1, 22050), src = audio.createBufferSource();
    src.buffer = b; src.connect(audio.destination);
    if (src.start) src.start(0); else src.noteOn(0);
  }
  document.addEventListener('touchend', unlockAudio, false);
  document.addEventListener('click', unlockAudio, false);

  function beep() {
    if (!soundOn || !audio) return;
    var notes = [880, 1175];
    for (var i = 0; i < notes.length; i++) {
      var o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + i * 0.18;
      o.frequency.value = notes[i];
      o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.25, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      if (o.start) { o.start(t); o.stop(t + 0.17); } else { o.noteOn(t); o.noteOff(t + 0.17); }
    }
  }

  function checkAlerts(s) {
    var msgs = [], states = {}, completed = {}, i;
    for (i = 0; i < s.active.length; i++) {
      var x = s.active[i];
      states[x.id] = x.state;
      completed[x.id] = x.completedAt || 0;
      // Um turno curto pode começar e terminar entre consultas, sem mostrar "working".
      // A primeira leitura só estabelece a referência, sem avisar sobre respostas antigas.
      var newReply = prevCompleted && completed[x.id] > (prevCompleted[x.id] || 0);
      if (prevStates && x.state === 'waiting' && !isSeen(x) && (prevStates[x.id] !== 'waiting' || newReply)) {
        pings[x.id] = s.now;
        msgs.push(x.project + ' (' + x.tool + ') espera você');
      }
      if (prevStates && x.state === 'permission' && prevStates[x.id] !== 'permission') {
        pings[x.id] = s.now;
        msgs.push(x.project + ' pede permissão: ' + x.permission.tool);
      }
    }
    prevStates = states;
    prevCompleted = completed;
    var names = [['claude', 'Claude'], ['codex', 'Codex']];
    for (i = 0; i < names.length; i++) {
      var q = s.quotas[names[i][0]], w = q && q.windows && q.windows.five_hour;
      if (!w || !w.pace) continue;
      var key = names[i][0] + w.resetsAt;
      var soon = w.used >= 90 || (w.pace.runsOutIn != null && w.pace.runsOutIn < 30 * 60e3);
      if (soon && !quotaAlerted[key]) {
        quotaAlerted[key] = true;
        msgs.push('Cota de 5h do ' + names[i][1] + (w.used >= 90 ? ' em ' + Math.round(w.used) + '%' : ' acaba em ' + dur(w.pace.runsOutIn)));
      }
    }
    if (msgs.length) { beep(); flash(msgs.join(' · ')); }
  }

  function setRemoteBtn(on) {
    $('remote').className = 'btn' + (on ? ' on' : '');
    $('remote').innerHTML = '🛰<span class="lbl"> ' + (on ? 'Remoto ligado' : 'Remoto') + '</span>';
  }

  function setSound(on) {
    soundOn = on;
    store('hud.sound', on ? '1' : '0');
    $('sound').innerHTML = on ? '🔔' : '🔕';
  }

  // ---- Ollama: cartão de status na linha das cotas (meia largura) -----------
  // As conversas do app do Ollama aparecem na grade como sessões normais; aqui fica só o estado
  // do servidor de cada PC: online, modelos carregados, instalados e GPU. Toque abre os detalhes.
  function gb(bytes) { return (bytes / 1073741824).toFixed(1) + ' GB'; }

  // unreachable: o PC secundário não responde, então não dá para saber do Ollama dele
  function ollamaState(o) {
    return o.online ? '<span class="lo">● online</span>'
      : '<span class="hi">● ' + (o.unreachable ? 'PC sem conexão' : 'fora do ar') + '</span>';
  }

  function ollamaPanel(s) {
    var el = $('q-ollama'), list = s.ollamas || [], html = '', i, j;
    if (!el) return;
    el.style.display = list.length ? '' : 'none';
    if (!list.length) return;
    var multi = s.machines && s.machines.length > 1;
    html += '<div class="qhead row">' + ollamaIcon() + '<span class="name">Ollama</span><span class="grow"></span><span class="chev">›</span></div>';
    // Só o essencial: está no ar? qual modelo está carregado? (o resto fica na gaveta)
    for (i = 0; i < list.length; i++) {
      var o = list[i];
      html += '<div class="ostat">' + (multi && o.machine ? '<div class="omach">🖥 ' + esc(o.machine) + '</div>' : '') +
        ollamaState(o);
      if (o.online && !o.models.length) html += '<div class="muted omodel">ocioso</div>';
      for (j = 0; o.online && j < o.models.length; j++) {
        var m = o.models[j];
        // % na GPU (velocidade) e até quando fica carregado
        html += '<div class="omodel ell"><b>' + esc(m.name) + '</b></div>' +
          '<div class="osmall2 muted">' + m.gpuPct + '% GPU' + (m.expiresAt ? ' · até ' + hm(m.expiresAt) : '') + '</div>';
      }
      // Uso: sessões do Ollama ativas neste PC (app ou terminal) e a última atividade
      var act = 0, last = 0, all = s.active.concat(s.recent), k2;
      for (k2 = 0; k2 < all.length; k2++) {
        var x = all[k2];
        if (x.tool !== 'Ollama' || (o.machine && x.machine && x.machine !== o.machine)) continue;
        if (x.state !== 'closed') act++;
        if (x.end > last) last = x.end;
      }
      var use = [];
      if (act) use.push(act + (act === 1 ? ' sessão ativa' : ' sessões ativas'));
      if (last) use.push('último uso ' + when(last).replace(/^às /, ''));
      if (use.length) html += '<div class="osmall2 muted ouse">' + use.join(' · ') + '</div>';
      html += '</div>';
    }
    el.innerHTML = html;
  }

  // Gaveta #ollama: detalhes de cada PC com Ollama
  function renderOllama() {
    if (!snap) return;
    var list = snap.ollamas || [], html = head(ollamaIcon() + 'Ollama'), i, j;
    if (!list.length) html += '<p class="empty">Nenhum PC com Ollama.</p>';
    for (i = 0; i < list.length; i++) {
      var o = list[i], g = o.gpu;
      html += '<div class="panel"><h2>🖥 ' + esc(o.machine || '') + '</h2>' +
        '<div class="dl"><span>Estado</span><span>' + ollamaState(o) + '</span></div>' +
        '<div class="dl"><span>Versão</span><span>' + esc(o.version || '—') + '</span></div>' +
        '<div class="dl"><span>Modelos instalados</span><span>' + (o.installed != null ? o.installed : '—') + '</span></div>' +
        (g ? '<div class="dl"><span>GPU</span><span>' + esc(g.name) + '</span></div>' +
          '<div class="dl"><span>Uso · temperatura</span><span>' + g.util + '% · ' + g.temp + '°C</span></div>' +
          '<div class="dl"><span>VRAM</span><span>' + (g.memUsed / 1024).toFixed(1) + ' / ' + (g.memTotal / 1024).toFixed(0) + ' GB</span></div>' : '') +
        '<h2 style="margin-top:12px">Modelos carregados</h2>';
      if (!o.models.length) html += '<div class="empty">Nenhum agora (o Ollama descarrega ~5 min após o último uso).</div>';
      for (j = 0; j < o.models.length; j++) {
        var m = o.models[j];
        html += '<div class="dl" style="border:0;padding-bottom:0"><span><b>' + esc(m.name) + '</b></span><span>' + gb(m.size) + '</span></div>' +
          '<div class="hbar"><div style="width:' + m.gpuPct + '%;background:#b39ddb"></div></div>' +
          '<div class="dl"><span class="muted">' + esc([m.params, m.quant].filter(Boolean).join(' · ')) + '</span><span class="muted">' +
          m.gpuPct + '% na GPU' + (m.expiresAt ? ' · até ' + hm(m.expiresAt) : '') + '</span></div>';
      }
      html += '</div>';
    }
    setOverlay(html);
  }

  var GRID_MIN = 6; // 2 linhas de 3 cartões

  function render(s) {
    setRemoteBtn(s.remoteMode);
    quotaPanel('q-claude', 'Claude', 0, s.quotas.claude, s.now, s.today['Claude Code'].fresh);
    quotaPanel('q-codex', 'Codex', 1, s.quotas.codex, s.now, s.today.Codex.fresh);
    ollamaPanel(s);
    // O servidor prioriza permissões e depois a última atividade, inclusive no hub.
    // Mantém a mesma ordem no navegador e no atalho, independentemente dos cards vistos.
    // Se sobrar espaço nas duas primeiras linhas, completa com as últimas sessões inativas.
    var active = s.active.slice();
    var used = active.length;
    var fill = s.recent.slice(0, Math.max(0, GRID_MIN - used));
    var html = '', waiting = 0, i;
    for (i = 0; i < active.length; i++) {
      html += sessCard(active[i], s.now);
      if (active[i].state === 'waiting' && !isSeen(active[i])) waiting++;
    }
    for (i = 0; i < fill.length; i++) html += sessCard(fill[i], s.now);
    $('sessList').innerHTML = html || '<div class="empty">Nenhuma sessão recente.</div>';
    $('sessTitle').innerHTML = 'Últimas sessões · ' + active.length + (active.length === 1 ? ' ativa' : ' ativas') +
      (waiting ? ' · <span style="color:#b3c6ff">' + waiting + ' esperando você</span>' : '');
    if (view === 'recent') renderRecent();
    if (view === 'stats') renderStats();
    if (view === 'usage') renderUsage();
    if (view === 'ollama') renderOllama();
  }

  // ---- Sobreposições: #s=<id> (detalhe) e #recentes ------------------------
  function stat(v, label) { return '<div class="stat"><div class="v">' + v + '</div><div class="k">' + label + '</div></div>'; }
  // Cabeçalho comum das gavetas: título à esquerda, ✕ redondo à direita
  function head(title, sub) {
    return '<div class="dtop row"><div class="grow"><div class="dtitle ell">' + title + '</div>' +
      (sub ? '<div class="dsub ell">' + sub + '</div>' : '') + '</div>' +
      '<button class="close" id="back" aria-label="Fechar">✕</button></div>';
  }
  function sessHead(x) {
    var idx = toolIndex(x.tool);
    // Claude e Codex com o ícone da página inicial; Antigravity (sem ícone) continua com a bolinha
    return head(toolIcon(idx) + esc(x.project) + ' <small class="muted">' + esc(x.tool) + machineTag(x) + '</small>',
      x.title ? esc(x.title) : '');
  }

  // Nome do PC da sessão: só aparece quando o hub junta mais de um PC
  function machineTag(x) {
    return snap && snap.machines && snap.machines.length > 1 && x.machine ? ' · 🖥 ' + esc(x.machine) : '';
  }

  // Gaveta da sessão, em ordem de uso: quem é → Abrir no PC → última resposta → Responder → mais detalhes (fechado)
  var moreOpen = store('hud.moreOpen') !== '0'; // aberto por padrão; lembra se o usuário fechar

  function ollamaRuntime(d) {
    var list = snap && snap.ollamas || [];
    for (var i = 0; i < list.length; i++) if (d.machine && list[i].machine === d.machine) return list[i];
    return !d.machine && list.length === 1 ? list[0] : null;
  }

  function ollamaMore(d) {
    var terminal = d.where === 'ollama-run', runtime = d.ollama || ollamaRuntime(d);
    var html = '<div class="stats">' + stat(terminal ? 'Terminal' : 'App', 'origem') +
      stat(dur(Math.max(0, d.now - d.start)), terminal ? 'aberta há' : 'idade da conversa');
    if (!terminal && d.prompts > 0) html += stat(d.prompts, 'pedidos na conversa');
    if (!terminal && d.history && d.history.length) html += stat(d.history.length, 'mensagens exibidas');
    var tokens = (d.input || 0) + (d.output || 0) + (d.cacheWrite || 0);
    if (tokens > 0) html += stat(k(tokens), 'tokens registrados no HUD');
    var generation = d.ollamaGeneration;
    if (generation) {
      if (generation.outputTokens > 0) html += stat(k(generation.outputTokens), 'tokens da última resposta');
      if (generation.tokensPerSecond > 0) html += stat(Number(generation.tokensPerSecond).toFixed(1), 'tokens/s de geração');
      if (generation.totalMs > 0) html += stat((generation.totalMs / 1000).toFixed(1) + 's', 'tempo total da resposta');
    }
    html += '</div>';
    if (d.lastReply) html += '<h2>Última resposta' + replyTime(d) + '</h2><div class="quote lastreply" style="margin-bottom:12px">' + esc(d.lastReply) + '</div>';
    else if (terminal) html += '<p class="muted" style="margin-bottom:12px">O terminal não grava a última resposta para consulta no HUD.</p>';
    if (!generation) html += '<p class="muted" style="margin-bottom:12px">Tokens/s são registrados nas novas respostas geradas pelo HUD.</p>';
    var row = function (label, value) { return '<div class="dl"><span>' + esc(label) + '</span><span>' + esc(value) + '</span></div>'; };
    html += row('Modelo', d.models.join(', ') || 'Não informado');
    if (d.machine) html += row('PC', d.machine);
    var pid = /(?:^|:)ollama-run-(\d+)$/.exec(d.id);
    if (terminal && pid) html += row('Processo (PID)', pid[1]);
    if (d.start) html += row(terminal ? 'Terminal aberto' : 'Conversa iniciada', when(d.start));
    if (d.end && (!terminal || d.lastPrompt)) html += row(terminal ? 'Último registro no histórico compartilhado' : 'Última atividade', when(d.end));
    if (runtime) {
      html += row('Servidor Ollama', runtime.online ? 'Online' : 'Fora do ar');
      if (runtime.version) html += row('Versão', runtime.version);
      if (runtime.installed != null) html += row('Modelos instalados', runtime.installed);
      var loaded = null, models = runtime.models || [];
      for (var i = 0; i < models.length && !loaded; i++) {
        for (var j = 0; j < d.models.length; j++) {
          if (String(models[i].name).replace(/:latest$/, '') === String(d.models[j]).replace(/:latest$/, '')) loaded = models[i];
        }
      }
      if (runtime.online) html += row('Modelo na memória', loaded ? 'Carregado' : 'Não carregado');
      if (loaded && runtime.online) {
        if (loaded.params) html += row('Parâmetros', loaded.params);
        if (loaded.quant) html += row('Quantização', loaded.quant);
        if (loaded.size > 0) html += row('Memória do modelo', gb(loaded.size));
        if (loaded.vram > 0) html += row('VRAM do modelo', gb(loaded.vram));
        if (loaded.gpuPct != null) html += row('Memória na GPU', loaded.gpuPct + '%');
        if (loaded.expiresAt) html += row('Carregado até', hm(loaded.expiresAt));
      }
      var gpu = runtime.gpu;
      if (gpu) {
        html += row('GPU do PC', gpu.name);
        if (gpu.util != null && gpu.temp != null) html += row('Uso · temperatura da GPU', gpu.util + '% · ' + gpu.temp + '°C');
        if (gpu.memTotal > 0) html += row('VRAM do PC', gb(gpu.memUsed * 1048576) + ' / ' + gb(gpu.memTotal * 1048576));
      }
    }
    return html;
  }

  // Horário da última resposta no título do painel ("às 09:12", "ontem 18:40")
  function replyTime(d) { return d.lastReplyAt ? ' <span class="htime">· ' + when(d.lastReplyAt) + '</span>' : ''; }

  function renderDetail(d) {
    var now = d.now, html = '';
    var pct = d.contextWindow ? Math.round(d.context / d.contextWindow * 100) : 0;
    var st = d.permission ? '<span class="badge perm">🔐 aguardando permissão</span>'
      : d.state === 'working' ?'<span class="badge working"><span class="pulse">●</span> trabalhando' + (d.lastTool ? ' · ' + esc(d.lastTool) : '') + '</span>'
      : d.state === 'waiting' ? (isSeen(d) ? '<span class="badge idle">visto</span>' : '<span class="badge waiting">sua vez há ' + dur(now - d.end) + '</span>')
      : d.state === 'idle' ? '<span class="badge idle">parada há ' + dur(now - d.end) + '</span>'
      : '<span class="badge closed">encerrada ' + when(d.end) + '</span>';
    html += sessHead(d);
    html += '<div class="dstate">' + st + '<span class="muted">' + (pct ? 'contexto ' + pct + '% · ' : '') + dur(d.end - d.start) + ' de sessão</span></div>';
    // Pedido de permissão (modo remoto) vem antes de tudo: a sessão está parada esperando isso
    if (d.permission) {
      html += '<div class="panel permbox"><h2>🔐 Pedido de permissão · ' + esc(d.permission.tool) + '</h2>' +
        '<div class="permcmd">' + esc(d.permission.summary) + '</div><div class="row">' +
        '<button class="pbtn allow" id="permAllow">Permitir</button><button class="pbtn deny" id="permDeny">Negar</button></div></div>';
    }
    var places = { vscode: 'no VS Code', terminal: 'no terminal', 'claude-desktop': 'no app do Claude', 'codex-desktop': 'no app do Codex', 'ollama-app': 'no app do Ollama', 'ollama-run': 'no terminal' };
    if (places[d.where]) {
      html += '<button class="pcaction" id="focusPc">🖥 Abrir no PC <small>' + places[d.where] + '</small></button>';
    }
    // Ler e responder sem rolar: última resposta (com rolagem própria) logo acima de Responder.
    // Ollama: no lugar dela, as últimas mensagens da conversa (ou comandos do terminal) como chat
    if (d.history && d.history.length) {
      var conv = '';
      for (var hi = 0; hi < d.history.length; hi++) {
        var hm2 = d.history[hi];
        conv += '<div class="msg ' + (hm2.role === 'user' ? 'me' : 'ai') + '">' + esc(hm2.content) +
          (hm2.at ? '<div class="mt">' + when(hm2.at) + '</div>' : '') + '</div>';
      }
      html += '<div class="panel"><h2>' + (d.where === 'ollama-run' ? 'Últimos comandos no terminal' : 'Últimas mensagens') + '</h2>' +
        '<div class="convo lastreply" id="lastReply">' + conv + '</div></div>';
    } else if (d.lastReply) html += '<div class="panel"><h2>Última resposta' + replyTime(d) + '</h2><div class="quote lastreply" id="lastReply">' + esc(d.lastReply) + '</div></div>';
    // ollama run no terminal: não há como escrever na conversa
    if (d.tool !== 'Antigravity' && d.where !== 'ollama-run') html += replyBox(d);
    if (d.where === 'ollama-run') html += '<div class="panel"><div class="muted" style="font-size:.85em">Conversa no terminal (ollama run): o Ollama não grava essas conversas, então não dá para ler as respostas nem responder por aqui. Use Abrir no PC.</div></div>';

    html += '<div class="panel more' + (moreOpen ? ' open' : '') + '" id="more"><button class="mhead row" id="moreToggle">' +
      '<h2 class="grow">Mais detalhes</h2><span class="arrow">▸</span></button><div class="mbody">';
    if (d.lastPrompt) html += '<h2>' + (d.where === 'ollama-run' ? 'Último comando no histórico compartilhado' : 'Seu último pedido') + '</h2><div class="quote" style="margin-bottom:12px">' + esc(d.lastPrompt) + '</div>';
    if (d.tool === 'Ollama') {
      html += ollamaMore(d);
    } else {
      html += '<div class="stats">' +
      stat(k(d.input + d.output + d.cacheWrite), 'tokens novos') + stat(k(d.output), 'saída') +
      stat(k(d.cacheRead), 'lidos do cache') + stat(k(d.cacheWrite), 'gravados no cache') +
      stat(d.context ? k(d.context) + (pct ? ' <small class="muted">' + pct + '%</small>' : '') : '—', 'contexto atual') +
      stat(d.prompts, 'pedidos seus') + stat(d.toolCalls, 'ferramentas usadas') +
      stat(d.subagents ? d.subagents + ' <small class="muted">' + k(d.subTokens) + '</small>' : '0', 'subagentes') +
      '</div>' + (pct ? '<div class="ctx" style="margin-bottom:12px"><div style="width:' + Math.min(100, pct) + '%;background:' + levelColor(pct) + '"></div></div>' : '');
    if (d.tools.length) {
      html += '<h2>Ferramentas mais usadas</h2>';
      for (var t = 0; t < d.tools.length; t++) {
        html += '<div class="dl" style="border:0;padding-bottom:0"><span>' + esc(d.tools[t][0]) + '</span><span>' + d.tools[t][1] + '</span></div>' +
          '<div class="hbar"><div style="width:' + (d.tools[t][1] / d.tools[0][1] * 100) + '%"></div></div>';
      }
    }
    if (d.turns.length) {
      html += '<h2 style="margin-top:12px">Últimas chamadas</h2>';
      for (var j = 0; j < d.turns.length; j++) {
        html += '<div class="dl"><span>' + hm(d.turns[j].t) + '</span><span>' + k(d.turns[j].fresh) + ' novos · ' + k(d.turns[j].cacheRead) + ' cache</span></div>';
      }
    }
    html += '<div class="dl" style="margin-top:12px"><span>Modelo</span><span>' + esc(d.models.join(', ') || '—') + '</span></div>' +
      '<div class="path" style="margin-top:8px">' + esc(d.cwd) + '</div>';
    }
    html += '</div></div>';
    setOverlay(html);
    rememberViewed(d);
    bindReply(d);
    var cv = $('lastReply');
    if (cv && cv.className.indexOf('convo') >= 0) cv.scrollTop = cv.scrollHeight; // chat abre no fim
    if (d.permission) {
      var decide = function (decision) {
        $('permAllow').disabled = $('permDeny').disabled = true;
        request('POST', '/api/permission', function (err) {
          if (err) { flash(err.message, false); } else { flash(decision === 'allow' ? 'Permitido.' : 'Negado.'); }
          d.permission = null;
          if (d.state === 'permission') d.state = 'working';
          renderDetail(d);
        }, { id: d.permission.id, decision: decision, session: d.id });
      };
      $('permAllow').onclick = function () { decide('allow'); };
      $('permDeny').onclick = function () { decide('deny'); };
    }
    $('moreToggle').onclick = function () {
      moreOpen = !moreOpen;
      store('hud.moreOpen', moreOpen ? '1' : '0');
      $('more').className = 'panel more' + (moreOpen ? ' open' : '');
    };
    if ($('focusPc')) $('focusPc').onclick = function () {
      var b = this;
      b.disabled = true;
      request('POST', '/api/focus', function (err, r) {
        b.disabled = false;
        flash(err ? 'Falhou: ' + err.message : r.message, !err && r.ok);
      }, { id: d.id });
    };
  }

  // ---- Resposta rápida (hook-stop.js entrega à sessão parada) ----------------
  var QUICK = ['Continue', 'Sim, implemente', 'Resuma', 'Não, pare aqui', 'Faça o commit', 'Rode os testes', 'Explique melhor'];

  function replyBox(d) {
    // Um status curto: chega na hora (hook ouvindo, ou Codex livre) ou espera a sessão parar
    var live = d.tool === 'Codex' || d.tool === 'Ollama' ? d.state !== 'working' : !!d.listening;
    var html = '<div class="panel reply"><div class="row rhead"><h2 class="grow">Responder</h2>' +
      (live ? '<span class="rtag lo">● ao vivo</span>' : '<span class="rtag">vai para a fila</span>') + '</div>';
    if (d.tool === 'Ollama') html += '<div class="rnote">A resposta é gerada no Ollama e fica no HUD; não aparece no app do Ollama.</div>';
    if (d.queued) html += '<div class="rqueued">Na fila: “' + esc(d.queued) + '” <button class="link" id="cancelReply">cancelar</button></div>';
    html += '<div class="chips">';
    for (var i = 0; i < QUICK.length; i++) html += '<button class="chip" data-chip="' + esc(QUICK[i]) + '">' + esc(QUICK[i]) + '</button>';
    return html + '</div><div class="row rform"><textarea id="replyText" rows="2" placeholder="Escreva ou fale uma resposta…"></textarea>' +
      (Speech ? '<button class="mic' + (rec ? ' on' : '') + '" id="micReply" aria-label="Falar a resposta" title="Falar a resposta">🎤</button>' : '') +
      '<button class="send" id="sendReply">Enviar</button></div></div>';
  }

  // ---- Ditado da resposta (Web Speech API do navegador) ------------------------
  // O texto falado entra na caixa, para revisar antes de enviar. O navegador só libera o microfone em
  // HTTPS ou no próprio PC (localhost). Sem a API (Safari 9, Firefox) ou fora desse contexto (aberto pela
  // rede em http) o ditado não funciona: o botão nem aparece.
  var Speech = window.isSecureContext === false ? null : window.SpeechRecognition || window.webkitSpeechRecognition, rec = null;

  // Junta os trechos reconhecidos. O Chrome no Android repete a frase acumulada em cada trecho e não põe
  // espaço entre eles ("teste" + "teste de voz" viraria "testeteste de voz"): trecho que já começa com
  // o texto anterior o substitui; os demais entram separados por espaço.
  function joinSpeech(results) {
    var text = '', t;
    for (var i = 0; i < results.length; i++) {
      t = String(results[i][0].transcript || '').replace(/^\s+|\s+$/g, '');
      if (!t) continue;
      if (text && t.toLowerCase().indexOf(text.toLowerCase()) === 0) text = t;
      else text = text ? text + ' ' + t : t;
    }
    return text;
  }

  function micState() { var b = $('micReply'); if (b) b.className = 'mic' + (rec ? ' on' : ''); }

  function stopMic() { if (rec) try { rec.stop(); } catch (e) {} }

  function toggleMic() {
    if (rec) return stopMic();
    var box = $('replyText'), base = box && box.value ? box.value.replace(/\s+$/, '') + ' ' : '';
    rec = new Speech();
    rec.lang = 'pt-BR';
    rec.continuous = true;      // continua ouvindo nas pausas; toque de novo para parar
    rec.interimResults = true;  // o texto aparece enquanto você fala
    rec.onresult = function (e) {
      var b = $('replyText');
      if (!b) return stopMic(); // a gaveta fechou
      b.value = base + joinSpeech(e.results);
    };
    rec.onerror = function (e) {
      if (e.error === 'aborted') return;
      flash(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'Microfone bloqueado: permita o acesso no navegador.'
        : e.error === 'no-speech' ? 'Não ouvi nada. Toque no 🎤 e fale.' : 'Microfone indisponível (' + e.error + ').', false);
    };
    rec.onend = function () { rec = null; micState(); };
    try { rec.start(); } catch (err) { rec = null; }
    micState();
  }

  function sendReply(d, text) {
    stopMic();
    $('sendReply').disabled = true;
    request('POST', '/api/reply', function (err, r) {
      if (err) { $('sendReply').disabled = false; return alert('Não enviado: ' + err.message); }
      $('replyText').value = '';
      $('replyText').blur();
      if (r.sent) { $('sendReply').disabled = false; return flash(d.tool === 'Ollama' ? 'Enviado: o Ollama está gerando a resposta.' : 'Enviado ao Codex.'); }
      d.queued = r.queued;
      d.listening = r.listening;
      renderDetail(d);
      if (r.queued) flash(r.listening ? 'Enviado: a sessão continua em instantes.' : 'Na fila: entra quando a sessão parar.');
    }, { key: d.key, text: text, tool: d.tool, id: d.id }); // id: o hub repassa ao PC dono da sessão
  }

  function bindReply(d) {
    if (!$('replyText')) return;
    var chips = $('overlayBody').getElementsByTagName('button');
    for (var i = 0; i < chips.length; i++) {
      if (!chips[i].getAttribute('data-chip')) continue;
      chips[i].onclick = function () { $('replyText').value = this.getAttribute('data-chip'); };
    }
    $('sendReply').onclick = function () {
      var text = $('replyText').value.replace(/^\s+|\s+$/g, '');
      if (text) sendReply(d, text);
    };
    if ($('cancelReply')) $('cancelReply').onclick = function () { sendReply(d, ''); };
    if ($('micReply')) $('micReply').onclick = toggleMic;
  }

  function flash(msg, ok) {
    var el = $('rflash');
    if (!el) { el = document.createElement('div'); el.id = 'rflash'; document.body.appendChild(el); }
    el.innerHTML = esc(msg);
    el.className = ok === false ? 'show err' : 'show';
    setTimeout(function () { el.className = ''; }, 3000);
  }

  // Não redesenha a gaveta enquanto o usuário escreve (apagaria o texto e fecharia o teclado)
  function typing() { var t = $('replyText'); return t && (t.value || document.activeElement === t || !!rec); }

  function renderRecent() {
    if (!snap) return;
    var html = head('Sessões'), i, all = snap.active.concat(snap.recent);
    html += '<div class="panel">';
    for (i = 0; i < all.length; i++) html += sessRow(all[i], snap.now);
    setOverlay(html + '</div>');
  }

  function setOverlay(html) { $('overlayBody').innerHTML = html; $('back').onclick = closeOverlay; }

  // Abre na hora com o que o snapshot já tem; os números completos chegam em seguida
  var detailCache = {};
  function quickDetail(id) {
    if (detailCache[id]) return renderDetail(detailCache[id]);
    var all = snap ? snap.active.concat(snap.recent) : [], x = null, i;
    for (i = 0; i < all.length; i++) if (all[i].id === id) x = all[i];
    if (!x) return setOverlay(head('Sessão') + '<p class="empty">carregando…</p>');
    setOverlay(sessHead(x) + '<div class="dstate">' + badge(x, snap.now) + '</div>' +
      (x.lastPrompt ? '<div class="panel"><h2>Seu último pedido</h2><div class="quote">' + esc(x.lastPrompt) + '</div></div>' : '') +
      '<p class="empty">carregando detalhes…</p>');
    rememberViewed(x);
  }

  function loadDetail() {
    var m = /^#s=(.+)$/.exec(location.hash);
    if (!m) return;
    var id = decodeURIComponent(m[1]);
    request('GET', '/api/session?id=' + encodeURIComponent(id), function (err, d) {
      if (location.hash !== '#s=' + encodeURIComponent(id)) return;
      if (err) return setOverlay(head('Sessão') + '<p class="empty">' + esc(err.message) + '</p>');
      if (d.tool === 'Ollama') d.ollama = ollamaRuntime(d);
      // Só redesenha se algo mudou ("now" sempre muda), preservando a rolagem da última resposta
      var sig = JSON.stringify(d).replace(/"now":\d+/, '');
      var prev = detailCache[id] && JSON.stringify(detailCache[id]).replace(/"now":\d+/, '');
      // Mantém no cache o detalhe exibido; uma atualização adiada precisa ser desenhada depois.
      if (typing()) return;
      detailCache[id] = d;
      if (sig === prev) return;
      var box = $('lastReply'), top = box ? box.scrollTop : 0;
      // Conversa (chat): se estava no fim, continua no fim para mostrar a mensagem nova
      var atEnd = !box || box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
      renderDetail(d);
      var nb = $('lastReply');
      if (nb) nb.scrollTop = nb.className.indexOf('convo') >= 0 && atEnd ? nb.scrollHeight : top;
    });
  }

  // A tela sobreposta fica no #hash: o botão Voltar do Android fecha
  function syncHash() {
    var h = location.hash;
    var nextSession = /^#s=(.+)$/.exec(h);
    if (viewedSession && (!nextSession || decodeURIComponent(nextSession[1]) !== viewedSession.id)) acknowledgeViewed();
    var usage = /^#uso=(claude|codex)$/.exec(h);
    usageName = usage ? usage[1] : null;
    view = /^#s=/.test(h) ? 'detail' : h === '#recentes' ? 'recent' : h === '#estatisticas' ? 'stats' : h === '#ollama' ? 'ollama' : usage ? 'usage' : null;
    $('overlay').className = $('backdrop').className = view ? 'show' : '';
    if (view) $('overlay').scrollTop = 0;
    else if (snap) render(snap); // o fundo não é redesenhado com a gaveta aberta
    if (view === 'detail') { quickDetail(decodeURIComponent(h.slice(3))); loadDetail(); }
    if (view === 'recent') renderRecent();
    // A gaveta precisa estar visível para o gráfico medir a própria largura
    if (view === 'stats') setTimeout(renderStats, 30);
    if (view === 'usage') setTimeout(renderUsage, 30);
    if (view === 'ollama') renderOllama();
  }
  function closeOverlay() { acknowledgeViewed(); if (location.hash) history.back(); else syncHash(); }

  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute('data-id')) { location.hash = 's=' + encodeURIComponent(el.getAttribute('data-id')); return; }
      el = el.parentNode;
    }
  });
  window.addEventListener('hashchange', syncHash);
  $('openRecent').onclick = function () { location.hash = 'recentes'; };
  $('openStats').onclick = function () { location.hash = 'estatisticas'; };
  $('q-ollama').onclick = function () { location.hash = 'ollama'; };
  $('q-claude').onclick = function () { location.hash = 'uso=claude'; };
  $('q-codex').onclick = function () { location.hash = 'uso=codex'; };
  $('backdrop').onclick = closeOverlay;

  // ---- Rede ----------------------------------------------------------------
  function request(method, url, done, body, timeout) {
    var x = new XMLHttpRequest();
    x.open(method, url + (token ? (url.indexOf('?') < 0 ? '?' : '&') + 't=' + token : ''), true);
    x.timeout = timeout || 60000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status === 200) { try { done(null, JSON.parse(x.responseText), x.responseText); } catch (e) { done(e); } return; }
      var err = new Error(x.status === 401 ? 'token inválido' : x.status === 404 ? 'sessão não encontrada' : x.status === 429 ? 'aguarde 30s' : x.status >= 400 && x.responseText ? x.responseText : 'sem conexão');
      err.offline = x.status === 0; // sem resposta nenhuma: servidor fora ou rede bloqueada
      done(err);
    };
    if (body) x.setRequestHeader('Content-Type', 'application/json');
    x.send(body ? JSON.stringify(body) : null);
  }

  // O iPad mini 1 é lento para redesenhar: só quando os dados mudaram, e não com a gaveta aberta
  var lastText = '';
  function apply(err, s, text) {
    if (err && err.offline) {
      // Wi-Fi instável (iPad antigo) perde um pedido de vez em quando: só mostra a tela de
      // desconectado na 2ª falha seguida; na 1ª, tenta de novo em ~3 s sem alarde
      failures++;
      if (failures >= 2) return setOffline(true);
      lastAttempt = new Date().getTime() - (offline ? RETRY_MS : POLL_MS) + 3000;
      return;
    }
    if (err) { $('status').innerHTML = '<span class="hi">● ' + esc(err.message) + '</span>'; return; }
    failures = 0;
    setOffline(false);
    lastOk = new Date().getTime();
    if (s && s.now) skew = s.now - lastOk;
    if (s && typeof s.tz === 'number') tzMs = s.tz * 60000;
    text = (text || '').replace(/^\{"now":\d+/, ''); // "now" muda sempre; o resto diz se algo mudou
    if (text && text === lastText) return;
    lastText = text;
    var first = !snap;
    snap = s;
    checkAlerts(s);
    if (first || !view) return render(s); // a primeira vez desenha o fundo mesmo com gaveta aberta
    if (view === 'stats') renderStats();
    if (view === 'usage') renderUsage();
    if (view === 'ollama') renderOllama();
    if (view === 'recent') renderRecent();
  }

  // ---- Desconectado: tela própria e nova tentativa a cada 5 s (conectado: a cada 10 s) ----
  var offline = false, inFlight = false, lastAttempt = 0, failures = 0;
  var POLL_MS = 10000, RETRY_MS = 5000;

  function setOffline(on) {
    if (on === offline) return;
    offline = on;
    $('offline').className = on ? 'show' : '';
    if (on) $('olast').innerHTML = lastOk ? 'Últimos dados recebidos às ' + hm(lastOk + skew) + '.' : '';
  }

  function poll() {
    if (inFlight) return;
    inFlight = true;
    lastAttempt = new Date().getTime();
    // Prazo curto: com o servidor fora, a tela de desconectado aparece em segundos
    request('GET', '/api/snapshot', function (err, s, text) { inFlight = false; apply(err, s, text); }, null, 8000);
    if (view === 'detail' && !offline) loadDetail();
  }

  // Relógio, status e agenda das consultas, a cada segundo
  function tick() {
    var t = new Date().getTime();
    $('clock').innerHTML = hm(t + skew);
    if (lastOk) {
      var ago = Math.round((t - lastOk) / 1000);
      $('status').innerHTML = ago > 40 ? '<span class="hi">● sem atualização há ' + ago + 's</span>' : '<span class="lo">●</span><span class="stxt"> ao vivo</span>';
    }
    var wait = (offline ? RETRY_MS : POLL_MS) - (t - lastAttempt);
    if (wait <= 0) poll();
    if (offline) {
      $('oretry').innerHTML = inFlight ? '<span class="pulse">●</span> Tentando reconectar…'
        : 'Nova tentativa em ' + Math.max(1, Math.ceil(wait / 1000)) + 's';
    }
  }

  setSound(soundOn);

  // Modo remoto: pedidos de permissão do Claude esperam Permitir/Negar aqui em vez de aparecer no PC
  $('remote').onclick = function () {
    var on = !(snap && snap.remoteMode);
    if (on && !confirm('Ligar o modo remoto?\n\nPedidos de permissão do Claude vão esperar sua resposta aqui (até 10 min) em vez de aparecer no PC. Use quando estiver longe do computador.')) return;
    request('POST', '/api/remote', function (err, r) {
      if (err) return flash('Falhou: ' + err.message, false);
      if (snap) snap.remoteMode = r.remoteMode;
      setRemoteBtn(r.remoteMode);
      flash(r.remoteMode ? 'Modo remoto ligado.' : 'Modo remoto desligado: permissões voltam para o PC.');
    }, { on: on });
  };
  $('sound').onclick = function () { unlockAudio(); setSound(!soundOn); if (soundOn) beep(); };

  $('refresh').onclick = function () {
    $('status').innerHTML = 'lendo cotas…';
    request('POST', '/api/refresh', apply);
  };

  // App instalado no Android que abriu sem tela cheia (o Chrome às vezes ignora o "fullscreen" do
  // manifest): o primeiro toque pede tela cheia. Não vale no navegador nem no iPad (sem display-mode).
  // Pela rede em http o Chrome nem instala como app (só em HTTPS): o atalho abre como aba comum.
  var installed = window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: minimal-ui)').matches);
  var rootEl = document.documentElement, enterFs = rootEl.requestFullscreen || rootEl.webkitRequestFullscreen;
  if (installed && enterFs) {
    var goFull = function () {
      document.removeEventListener('touchend', goFull, false);
      try { var p = enterFs.call(rootEl); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    };
    document.addEventListener('touchend', goFull, false);
  }

  window.addEventListener('resize', function () { if (snap) burnChart(snap, view === 'usage' ? usageName : null); });
  $('oretryNow').onclick = function () { poll(); tick(); };
  syncHash(); poll(); tick();
  setInterval(tick, 1000);
  // Ao voltar do bloqueio de tela o iOS congela timers; atualiza na hora
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  // PWA: só em HTTPS/localhost (Chrome no Android via Tailscale); o iOS 9 não tem service worker
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
})();
