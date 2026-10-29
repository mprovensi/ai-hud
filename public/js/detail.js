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
    var html = '<div class="stats">' + stat(terminal ? 'Terminal' : d.where === 'ollama-api' ? 'API' : 'App', 'origem') +
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
      html += '<div class="panel"><h2>' + (d.where === 'ollama-run' && !d.lastReply ? 'Últimos comandos no terminal' : 'Últimas mensagens') + '</h2>' +
        '<div class="convo lastreply" id="lastReply">' + conv + '</div></div>';
    } else if (d.lastReply) html += '<div class="panel"><h2>Última resposta' + replyTime(d) + '</h2><div class="quote lastreply" id="lastReply">' + esc(d.lastReply) + '</div></div>';
    // ollama run no terminal: não há como escrever na conversa
    if (d.tool !== 'Antigravity' && d.where !== 'ollama-run') html += replyBox(d);
    if (d.where === 'ollama-run' && !d.lastReply) html += '<div class="panel"><div class="muted" style="font-size:.85em">Conversa no terminal (ollama run): o Ollama não grava essas conversas, então não dá para ler as respostas nem responder por aqui. Use Abrir no PC.</div></div>';

    html += '<div class="panel more' + (moreOpen ? ' open' : '') + '" id="more"><button class="mhead row" id="moreToggle">' +
      '<h2 class="grow">Mais detalhes</h2><span class="arrow">▸</span></button><div class="mbody">';
    if (d.lastPrompt) html += '<h2>' + (d.where === 'ollama-run' && !d.lastReply ? 'Último comando no histórico compartilhado' : 'Seu último pedido') + '</h2><div class="quote" style="margin-bottom:12px">' + esc(d.lastPrompt) + '</div>';
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

