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
      '<div class="track grow"><div class="fill" style="width:' + used + '%;background:' + levelFill(used) + '"></div>' +
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
    return brandIcon(idx);
  }
  function brandIcon(idx) {
    var slug = idx === 1 ? 'codex' : idx === 2 ? 'gemini' : 'claude';
    return '<img class="brand" src="/brand-' + slug + '.svg" alt="">';
  }

  function quotaPanel(id, name, idx, q, now, used) {
    var html = '<div class="qhead row"' + (q && q.plan ? ' title="Plano ' + esc(q.plan) + '"' : '') + '>' + brandIcon(idx) + '<span class="name">' + name + '</span>' +
      '<span class="grow"></span><span class="tokens" title="Tokens usados hoje">' + k(used) + ' <small>hoje</small></span><span class="chev">›</span></div>';
    if (!q) html += '<div class="empty">lendo…</div>';
    else {
      var w = q.windows || {}, gauges = '';
      if (w.five_hour) gauges += gauge('5h', 'Janela de 5 horas', w.five_hour, now);
      if (w.seven_day) gauges += gauge('7d', 'Semana', w.seven_day, now);
      if (w.pro) gauges += gauge('Pro', 'Cota diária Pro' + (w.pro.modelId ? ' (' + w.pro.modelId + ')' : ''), w.pro, now);
      if (w.flash) gauges += gauge('Fla', 'Cota diária Flash' + (w.flash.modelId ? ' (' + w.flash.modelId + ')' : ''), w.flash, now);
      if (w.daily) gauges += gauge('24h', 'Cota diária' + (w.daily.modelId ? ' (' + w.daily.modelId + ')' : ''), w.daily, now);
      if (gauges) html += gauges;
      else if (!q.error) html += '<div class="empty">sem cota de plano</div>';
      if (q.error) html += '<div class="qerr">⚠ ' + esc(q.error) + '</div>';
    }
    $(id).innerHTML = html;
  }

