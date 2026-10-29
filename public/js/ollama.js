  // ---- Ollama: cartão de status na linha das cotas (meia largura) -----------
  // As conversas do app do Ollama aparecem na grade como sessões normais; aqui fica só o estado
  // do servidor de cada PC: online, modelos carregados, instalados e GPU. Toque abre os detalhes.
  function gb(bytes) { return (bytes / 1073741824).toFixed(1) + ' GB'; }

  // unreachable: o PC secundário não responde, então não dá para saber do Ollama dele
  function ollamaState(o) {
    return o.online ? '<span class="lo">● online</span>'
      : o.unavailable ? '<span class="warn">● aguardando informações</span>'
      : '<span class="hi">● ' + (o.unreachable ? 'PC sem conexão' : 'fora do ar') + '</span>';
  }

  function ollamaPanel(s) {
    var el = $('q-ollama'), list = s.ollamas || [], html = '', i, j;
    if (!el) return;
    el.style.display = '';
    var multi = s.machines && s.machines.length > 1;
    html += '<div class="qhead row">' + ollamaIcon() + '<span class="name">Ollama</span><span class="grow"></span><span class="chev">›</span></div>';
    if (!list.length) html += '<div class="empty">Aguardando informações dos PCs com Ollama.</div>';
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
      if (o.unreachable || o.unavailable) html += '<div class="empty">Modelos indisponíveis para consulta' + (o.unreachable ? ': PC sem conexão.' : ': aguardando informações do PC.') + '</div>';
      else if (!o.models.length) html += '<div class="empty">Nenhum agora (o Ollama descarrega ~5 min após o último uso).</div>';
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

