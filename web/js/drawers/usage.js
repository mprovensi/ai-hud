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

