  var GRID_MIN = 6; // 2 linhas de 3 cartões

  function render(s) {
    setRemoteBtn(s.remoteMode);
    var td = s.today || {}, qs = s.quotas || {};
    quotaPanel('q-claude', 'Claude', 0, qs.claude, s.now, td['Claude Code'] ? td['Claude Code'].fresh : 0);
    quotaPanel('q-codex', 'Codex', 1, qs.codex, s.now, td.Codex ? td.Codex.fresh : 0);
    quotaPanel('q-gemini', 'Gemini', 2, qs.gemini, s.now, td.Gemini ? td.Gemini.fresh : 0);
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
    if ($('sessList').removeAttribute) $('sessList').removeAttribute('aria-busy');
    $('sessTitle').innerHTML = 'Últimas sessões · ' + active.length + (active.length === 1 ? ' ativa' : ' ativas') +
      (waiting ? ' · <span style="color:#b3c6ff">' + waiting + ' esperando você</span>' : '');
    if (view === 'recent') renderRecent();
    if (view === 'stats') renderStats();
    if (view === 'usage') renderUsage();
    if (view === 'ollama') renderOllama();
  }

