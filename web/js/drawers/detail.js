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
    var origins = { 'gemini-cli': 'Gemini CLI', antigravity: 'Antigravity', 'antigravity-cli': 'Antigravity CLI' };
    var origin = x.tool === 'Gemini' && origins[x.where] ? ' · ' + origins[x.where] : '';
    return head(toolIcon(idx) + esc(x.project) + ' <small class="muted">' + esc(x.tool) + origin + machineTag(x) + '</small>',
      x.title ? esc(x.title) : '');
  }

  // Nome do PC da sessão: só aparece quando o hub junta mais de um PC
  function machineTag(x) {
    return snap && snap.machines && snap.machines.length > 1 && x.machine ? ' · 🖥 ' + esc(x.machine) : '';
  }

  // Gaveta da sessão: abas Conversa | Detalhes
  var moreOpen = store('hud.moreOpen') !== '0';

  function ollamaRuntime(d) {
    var list = snap && snap.ollamas || [];
    for (var i = 0; i < list.length; i++) if (d.machine && list[i].machine === d.machine) return list[i];
    return !d.machine && list.length === 1 ? list[0] : null;
  }
  var detailTab = 'convo', detailSessionId = '', detailFocusedId = '', qState = null;

  // ---- Markdown leve e seguro (ES5 / Safari 9, escapa HTML antes de formatar) ----
  function mdInline(text) {
    var s = esc(text), codes = [];
    s = s.replace(/`([^`\n]+)`/g, function (_, c) {
      codes.push('<code class="md-code">' + c + '</code>');
      return '\x00C' + (codes.length - 1) + '\x00';
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
    return s.replace(/\x00C(\d+)\x00/g, function (_, i) { return codes[+i]; });
  }

  function isTableSep(line) { return /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line) && line.indexOf('-') >= 0; }
  function tableCells(line) {
    var trimmed = line.replace(/^\s*\||\|\s*$/g, '');
    var parts = trimmed.split('|'), out = [];
    for (var i = 0; i < parts.length; i++) out.push(parts[i].replace(/^\s+|\s+$/g, ''));
    return out;
  }

  function renderMdBlock(block) {
    var lines = block.split(/\r?\n/), out = [], i = 0;
    while (i < lines.length) {
      var line = lines[i], trimmed = line.replace(/^\s+|\s+$/g, '');
      if (!trimmed) { i++; continue; }
      if (/^([-*_])\1{2,}$/.test(trimmed)) { out.push('<hr class="md-hr">'); i++; continue; }
      var h = /^(#{1,4})\s+(.+)$/.exec(trimmed);
      if (h) { out.push('<div class="md-h md-h' + h[1].length + '">' + mdInline(h[2]) + '</div>'); i++; continue; }
      if (/^>\s?/.test(trimmed)) {
        var bq = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          bq.push(mdInline(lines[i].replace(/^\s*>\s?/, '')));
          i++;
        }
        out.push('<div class="md-bq">' + bq.join('<br>') + '</div>');
        continue;
      }
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var th = tableCells(line), tbl = '<div class="md-tbl"><table><thead><tr>', c;
        for (c = 0; c < th.length; c++) tbl += '<th>' + mdInline(th[c]) + '</th>';
        tbl += '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].replace(/^\s+|\s+$/g, '')) {
          var td = tableCells(lines[i]);
          tbl += '<tr>';
          for (c = 0; c < td.length; c++) tbl += '<td>' + mdInline(td[c]) + '</td>';
          tbl += '</tr>';
          i++;
        }
        out.push(tbl + '</tbody></table></div>');
        continue;
      }
      if (/^\s*[-*•]\s+/.test(line)) {
        var ul = [];
        while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
          ul.push('<li>' + mdInline(lines[i].replace(/^\s*[-*•]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul class="md-ul">' + ul.join('') + '</ul>');
        continue;
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        var ol = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          ol.push('<li>' + mdInline(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ol class="md-ol">' + ol.join('') + '</ol>');
        continue;
      }
      var para = [];
      while (i < lines.length) {
        var l = lines[i], tr = l.replace(/^\s+|\s+$/g, '');
        if (!tr || /^(#{1,4})\s+/.test(tr) || /^>\s?/.test(tr) || /^([-*_])\1{2,}$/.test(tr) ||
            /^\s*[-*•]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l) ||
            (l.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1]))) break;
        para.push(mdInline(l));
        i++;
      }
      out.push('<p class="md-p">' + para.join('<br>') + '</p>');
    }
    return out.join('');
  }

  function renderMd(raw) {
    var text = String(raw == null ? '' : raw), re = /```([^\n`]*)\n?([\s\S]*?)```/g, out = '', last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out += renderMdBlock(text.slice(last, m.index));
      var code = m[2].replace(/\n$/, '');
      out += '<pre class="md-pre"><code>' + esc(code) + '</code></pre>';
      last = m.index + m[0].length;
    }
    if (last < text.length) out += renderMdBlock(text.slice(last));
    return out || '<p class="md-p">' + esc(text) + '</p>';
  }

  function formatToolSummary(tools) {
    if (!tools || !tools.length) return '';
    var uniq = [], seen = {}, i;
    for (i = 0; i < tools.length; i++) {
      if (!seen[tools[i]]) { seen[tools[i]] = true; uniq.push(tools[i]); }
    }
    var n = tools.length;
    return '⚙ ' + n + (n === 1 ? ' ferramenta' : ' ferramentas') + ' · ' + uniq.slice(0, 3).join(', ') + (uniq.length > 3 ? '…' : '');
  }

  // ---- Cartão interativo de múltipla escolha (AskUserQuestion / request_user_input / texto) ----
  function questionCard(d) {
    var q = d.question;
    if (!q || !q.questions || !q.questions.length) return '';
    var ro = q.mode === 'readonly', perm = q.mode === 'permission', i, j;
    var html = '<div class="panel qbox' + (perm ? ' permbox' : '') + '" id="qbox">' +
      '<h2>' + (perm ? '🔐 Pergunta da IA · aguardando resposta' : '❓ Pergunta da IA') + '</h2>';
    for (i = 0; i < q.questions.length; i++) {
      var item = q.questions[i], multi = !!item.multiSelect;
      html += '<div class="qitem" data-qi="' + i + '">' +
        '<div class="qprompt">' + (item.header ? '<span class="qtag">' + esc(item.header) + '</span>' : '') +
        esc(item.question) + '</div>' +
        '<div class="qhint">' + (multi ? 'Pode marcar várias opções' : 'Escolha uma opção') + '</div><div class="qopts">';
      for (j = 0; j < item.options.length; j++) {
        var opt = item.options[j];
        html += '<button type="button" class="qopt' + (ro ? ' qopt-ro' : '') + '" data-qi="' + i + '" data-oi="' + j + '"' +
          (ro ? ' disabled' : ' aria-pressed="false"') + '>' +
          '<span class="qmark' + (multi ? ' sq' : '') + '" aria-hidden="true"></span>' +
          '<span class="qopt-body"><span class="qopt-lbl">' + esc(opt.label) + '</span>' +
          (opt.description ? '<span class="qopt-desc">' + esc(opt.description) + '</span>' : '') +
          '</span></button>';
      }
      html += '</div>';
      if (!ro) {
        html += '<input type="text" class="qother" data-qi="' + i + '" placeholder="Outro ou observação (opcional)…">';
      }
      html += '</div>';
    }
    if (ro) {
      html += '<div class="qro-note">Responda esta pergunta no PC (esta ferramenta não aceita resposta remota pelo HUD).</div>';
    } else {
      html += '<div class="row qactions"><button type="button" class="pbtn allow" id="qSend" disabled>Enviar resposta</button>' +
        (perm ? '<button type="button" class="pbtn deny" id="qDeny">Negar</button>' : '') + '</div>';
    }
    return html + '</div>';
  }

  function buildQuestionPayload(questions, sel, others) {
    var answers = {}, lines = [], i, j;
    for (i = 0; i < questions.length; i++) {
      var q = questions[i], picked = [], map = sel[i] || {};
      for (j = 0; j < q.options.length; j++) if (map[j]) picked.push(q.options[j].label);
      var custom = String(others[i] || '').replace(/^\s+|\s+$/g, '');
      if (custom) picked.push(custom);
      if (!picked.length) continue;
      var val = picked.join(', ');
      answers[q.question] = val;
      lines.push(questions.length > 1 ? (i + 1) + '. ' + q.question + ': ' + val : val);
    }
    return { answers: answers, text: lines.join('\n') };
  }

  function bindQuestion(d) {
    qState = null;
    var box = $('qbox'), q = d.question;
    if (!box || !q || q.mode === 'readonly' || !q.questions || !q.questions.length) return;
    var sel = {}, others = {}, i;
    for (i = 0; i < q.questions.length; i++) { sel[i] = {}; others[i] = ''; }
    qState = { sel: sel, others: others };

    function hasAny() {
      for (var qi = 0; qi < q.questions.length; qi++) {
        if (String(others[qi] || '').replace(/^\s+|\s+$/g, '')) return true;
        for (var k2 in sel[qi]) if (sel[qi][k2]) return true;
      }
      return false;
    }
    function syncUi() {
      var btns = box.getElementsByTagName('button');
      for (var b = 0; b < btns.length; b++) {
        var bqi = btns[b].getAttribute('data-qi'), boi = btns[b].getAttribute('data-oi');
        if (bqi == null || boi == null) continue;
        var on = !!(sel[+bqi] && sel[+bqi][+boi]);
        btns[b].className = 'qopt' + (on ? ' sel' : '');
        btns[b].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if ($('qSend')) $('qSend').disabled = !hasAny();
    }

    var btns = box.getElementsByTagName('button');
    for (i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-oi') == null) continue;
      btns[i].onclick = function () {
        var qi = +this.getAttribute('data-qi'), oi = +this.getAttribute('data-oi');
        if (q.questions[qi].multiSelect) {
          sel[qi][oi] = !sel[qi][oi];
        } else {
          var was = !!sel[qi][oi];
          sel[qi] = {};
          if (!was) sel[qi][oi] = true;
        }
        syncUi();
      };
    }
    var inputs = box.getElementsByTagName('input');
    for (i = 0; i < inputs.length; i++) {
      if (inputs[i].getAttribute('data-qi') == null) continue;
      inputs[i].oninput = function () {
        others[+this.getAttribute('data-qi')] = this.value;
        syncUi();
      };
    }
    syncUi();
    if ($('qSend')) $('qSend').onclick = function () {
      var payload = buildQuestionPayload(q.questions, sel, others);
      if (!payload.text) return;
      $('qSend').disabled = true;
      if ($('qDeny')) $('qDeny').disabled = true;
      if (q.mode === 'permission') {
        request('POST', '/api/permission', function (err) {
          if (err) {
            $('qSend').disabled = false;
            if ($('qDeny')) $('qDeny').disabled = false;
            return flash(err.message, false);
          }
          qState = null;
          d.permission = null;
          d.question = null;
          if (d.state === 'permission') d.state = 'working';
          flash('Resposta enviada.');
          renderDetail(d);
        }, { id: q.permissionId, decision: 'answer', answers: payload.answers, text: payload.text, session: d.id });
      } else {
        qState = null;
        d.question = null;
        sendReply(d, payload.text);
      }
    };
    if ($('qDeny')) $('qDeny').onclick = function () {
      $('qSend').disabled = $('qDeny').disabled = true;
      request('POST', '/api/permission', function (err) {
        if (err) flash(err.message, false); else flash('Negado.');
        qState = null;
        d.permission = null;
        d.question = null;
        if (d.state === 'permission') d.state = 'working';
        renderDetail(d);
      }, { id: q.permissionId, decision: 'deny', session: d.id });
    };
  }

  function ollamaMore(d) {
    var terminal = d.where === 'ollama-run', runtime = d.ollama || ollamaRuntime(d);
    var html = '<div class="stats">' + stat(terminal ? 'Terminal' : d.where === 'ollama-api' ? 'API' : d.where === 'ollama-hud' ? 'HUD' : 'App', 'origem') +
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

  function renderConversation(d) {
    var msgs = d.history && d.history.length ? d.history : null;
    if (!msgs && (d.lastPrompt || d.lastReply)) {
      msgs = [];
      if (d.lastPrompt) msgs.push({ role: 'user', content: d.lastPrompt, at: 0 });
      if (d.lastReply) msgs.push({ role: 'assistant', content: d.lastReply, at: d.lastReplyAt || 0 });
    }
    var hasQ = !!(d.question && d.question.questions && d.question.questions.length);
    var html = '<div class="panel convpanel' + (hasQ ? ' has-q' : '') + '">';
    if (msgs && msgs.length) {
      var title = d.where === 'ollama-run' && !d.lastReply ? 'Últimos comandos no terminal' : 'Conversa';
      html += '<div class="row chead"><h2 class="grow">' + title + '</h2>' +
        (d.lastReplyAt ? '<span class="muted ctime">' + when(d.lastReplyAt) + '</span>' : '') + '</div>' +
        '<div class="convo lastreply" id="lastReply" tabindex="-1">';
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i], isMe = m.role === 'user';
        if (!isMe && m.tools && m.tools.length) {
          html += '<div class="mtools">' + esc(formatToolSummary(m.tools)) + '</div>';
        }
        html += '<div class="msg ' + (isMe ? 'me' : 'ai') + '">' +
          (isMe ? '<div class="mtxt">' + esc(m.content) + '</div>' : '<div class="md">' + renderMd(m.content) + '</div>') +
          (m.at ? '<div class="mt">' + when(m.at) + '</div>' : '') + '</div>';
      }
      if (d.state === 'working') {
        html += '<div class="mworking"><span class="pulse">●</span> ' + esc(d.lastTool ? 'executando ' + d.lastTool + '…' : 'pensando…') + '</div>';
      }
      html += '</div>';
    } else if (d.where === 'ollama-run') {
      html += '<div class="muted" style="font-size:.85em">Conversa no terminal (ollama run): o Ollama não grava essas conversas, então não dá para ler as respostas nem responder por aqui. Use Abrir no PC.</div>';
    } else {
      html += '<div class="empty">Nenhuma mensagem registrada nesta sessão ainda.</div>';
    }
    return html + '</div>';
  }

  function renderDetail(d) {
    if (d.id !== detailSessionId) { detailSessionId = d.id; detailTab = 'convo'; }
    var now = d.now, html = '';
    var pct = d.contextWindow ? Math.round(d.context / d.contextWindow * 100) : 0;
    var st = d.permission ? '<span class="badge perm">🔐 aguardando permissão</span>'
      : d.state === 'working' ? '<span class="badge working"><span class="pulse">●</span> trabalhando' + (d.lastTool ? ' · ' + esc(d.lastTool) : '') + '</span>'
      : d.state === 'waiting' ? (isSeen(d) ? '<span class="badge idle">visto</span>' : '<span class="badge waiting">sua vez há ' + dur(now - d.end) + '</span>')
      : d.state === 'idle' ? '<span class="badge idle">parada há ' + dur(now - d.end) + '</span>'
      : '<span class="badge closed">encerrada ' + when(d.end) + '</span>';
    html += sessHead(d);
    var places = { vscode: 'VS Code', terminal: 'terminal', 'claude-desktop': 'app Claude', 'codex-desktop': 'app Codex', antigravity: 'Antigravity', 'antigravity-cli': 'terminal', 'gemini-cli': 'terminal', 'ollama-app': 'app Ollama', 'ollama-run': 'terminal' };
    html += '<div class="dstate row">' + st + '<span class="muted grow ell">' + (pct ? 'ctx ' + pct + '% · ' : '') + dur(d.end - d.start) + '</span>' +
      (d.canFocus !== false && places[d.where] ? '<button class="pcmini" id="focusPc" title="Abrir no PC (' + places[d.where] + ')">🖥 Abrir no PC</button>' : '') + '</div>';

    // Pedido de permissão comum (Bash, Edit, etc.) fica sempre visível no topo; AskUserQuestion usa o cartão de opções
    var isPermQuestion = d.permission && d.question && d.question.mode === 'permission';
    if (d.permission && !isPermQuestion) {
      html += '<div class="panel permbox"><h2>🔐 Pedido de permissão · ' + esc(d.permission.tool) + '</h2>' +
        '<div class="permcmd">' + esc(d.permission.summary) + '</div><div class="row">' +
        '<button class="pbtn allow" id="permAllow">Permitir</button><button class="pbtn deny" id="permDeny">Negar</button></div></div>';
    }

    // Abas Conversa | Detalhes
    var onConvo = detailTab !== 'details';
    html += '<div class="dtabs row" role="tablist">' +
      '<button type="button" class="dtab' + (onConvo ? ' active' : '') + '" id="tabConvo" role="tab" aria-selected="' + (onConvo ? 'true' : 'false') + '">Conversa</button>' +
      '<button type="button" class="dtab' + (!onConvo ? ' active' : '') + '" id="tabDetails" role="tab" aria-selected="' + (!onConvo ? 'true' : 'false') + '">Detalhes</button></div>';

    // ---- Aba Conversa ----
    html += '<div class="dtab-pane' + (onConvo ? ' active' : '') + '" id="paneConvo">';
    if (d.testRun && !d.testRun.ok) {
      html += '<div class="panel testbox"><h2>✗ Teste falhou' + (d.testRun.at ? ' <span class="htime">· ' + when(d.testRun.at) + '</span>' : '') + '</h2>' +
        '<div class="permcmd">' + esc(d.testRun.command) + '</div>' +
        (d.testRun.summary ? '<div class="quote">' + esc(d.testRun.summary) + '</div>' : '') + '</div>';
    }
    html += renderConversation(d);
    html += questionCard(d);
    // ollama run no terminal e sessões legadas sem UUID: não há resposta rápida pelo HUD
    var canReply = d.tool !== 'Antigravity' && d.where !== 'ollama-run' && (d.tool !== 'Gemini' || /(?:^|:)[0-9a-f-]{36}$/.test(String(d.id || '')));
    if (canReply) html += replyBox(d);
    html += '</div>';

    // ---- Aba Detalhes ----
    html += '<div class="dtab-pane' + (!onConvo ? ' active' : '') + '" id="paneDetails">';
    html += '<div class="panel">';
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
        '</div>' + (pct ? '<div class="ctx" style="margin-bottom:12px"><div class="fill" style="width:' + Math.min(100, pct) + '%;background:' + levelFill(pct) + '"></div></div>' : '');
      if (d.files && d.files.length) {
        html += '<h2>Arquivos modificados · ' + d.files.length + '</h2>';
        for (var f = 0; f < d.files.length; f++) {
          html += '<div class="dl"><span class="path" title="' + esc(d.files[f][0]) + '">' + esc(d.files[f][0]) + '</span><span class="muted">' + d.files[f][1] + '×</span></div>';
        }
      }
      if (d.tools.length) {
        html += '<h2' + (d.files && d.files.length ? ' style="margin-top:12px"' : '') + '>Ferramentas mais usadas</h2>';
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
      var origins = { 'gemini-cli': 'Gemini CLI', antigravity: 'Antigravity', 'antigravity-cli': 'Antigravity CLI' };
      if (origins[d.where]) html += '<div class="dl" style="margin-top:12px"><span>Origem</span><span>' + esc(origins[d.where]) + '</span></div>';
      html += '<div class="dl"' + (origins[d.where] ? '' : ' style="margin-top:12px"') + '><span>Modelo</span><span>' + esc(d.models.join(', ') || '—') + '</span></div>' +
        '<div class="path" style="margin-top:8px">' + esc(d.cwd) + '</div>';
    }
    html += '</div>';
    // Encerrar fica na aba Detalhes, longe dos botões de uso frequente; só para sessões com processo conhecido
    if (d.state !== 'closed' && (d.tool === 'Claude Code' || d.where === 'ollama-run')) {
      html += '<button class="pcaction danger" id="closeSess">⏹ Encerrar sessão</button>';
    }
    html += '</div>';

    setOverlay(html);
    rememberViewed(d);
    bindQuestion(d);
    bindReply(d);
    var cv = $('lastReply');
    if (cv && cv.className.indexOf('convo') >= 0) cv.scrollTop = cv.scrollHeight; // chat abre no fim
    // Move o foco para a conversa/gaveta ao abrir uma sessão (permite rolar direto sem clicar de novo)
    if (detailFocusedId !== d.id) {
      detailFocusedId = d.id;
      var target = cv || $('overlay');
      if (target && target.focus) {
        try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (e2) {} }
      }
    }
    function switchTab(next) {
      detailTab = next;
      var cOn = next !== 'details';
      if ($('tabConvo')) { $('tabConvo').className = 'dtab' + (cOn ? ' active' : ''); $('tabConvo').setAttribute('aria-selected', cOn ? 'true' : 'false'); }
      if ($('tabDetails')) { $('tabDetails').className = 'dtab' + (!cOn ? ' active' : ''); $('tabDetails').setAttribute('aria-selected', !cOn ? 'true' : 'false'); }
      if ($('paneConvo')) $('paneConvo').className = 'dtab-pane' + (cOn ? ' active' : '');
      if ($('paneDetails')) $('paneDetails').className = 'dtab-pane' + (!cOn ? ' active' : '');
    }
    if ($('tabConvo')) $('tabConvo').onclick = function () { switchTab('convo'); };
    if ($('tabDetails')) $('tabDetails').onclick = function () { switchTab('details'); };
    if (d.permission && !isPermQuestion && $('permAllow') && $('permDeny')) {
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
    if ($('focusPc')) $('focusPc').onclick = function () {
      var b = this;
      b.disabled = true;
      request('POST', '/api/focus', function (err, r) {
        b.disabled = false;
        flash(err ? 'Falhou: ' + err.message : r.message, !err && r.ok);
      }, { id: d.id });
    };
    if ($('closeSess')) $('closeSess').onclick = function () {
      if (!confirm('Encerrar a sessão "' + (d.title || d.project) + '"?\n\nO processo dela no PC será finalizado.')) return;
      var b = this;
      b.disabled = true;
      request('POST', '/api/close', function (err, r) {
        b.disabled = false;
        flash(err ? 'Falhou: ' + err.message : r.message, !err && r.ok);
        if (!err && r.ok) { d.state = 'closed'; d.end = Date.now(); renderDetail(d); }
      }, { id: d.id });
    };
  }
