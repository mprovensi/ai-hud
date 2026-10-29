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

