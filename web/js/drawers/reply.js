  // ---- Resposta rápida (hook-stop.js entrega à sessão parada) ----------------
  var QUICK = ['Sim', 'Continue', 'Sim, implemente', 'Resuma', 'Não, pare aqui', 'Faça o commit', 'Rode os testes', 'Explique melhor'];
  var chipsOpen = false;
  var replyAiChoice = {};
  var replyAiOpen = false;
  var replyAiLastId = '';
  var replyAiDocBound = false;

  function closeReplyAiMenu() {
    if (!replyAiOpen) return;
    replyAiOpen = false;
    var btn = $('replyAiBtn'), menu = $('replyAiMenu');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (menu) menu.className = 'rai-menu';
  }

  function isInsideReplyAi(node) {
    var wrap = $('replyAiWrap');
    if (!wrap) return false;
    var el = node;
    while (el) {
      if (el === wrap) return true;
      el = el.parentNode;
    }
    return false;
  }

  function bindReplyAiOutsideClose() {
    if (replyAiDocBound || typeof document === 'undefined' || !document.addEventListener) return;
    replyAiDocBound = true;
    var onOutside = function (ev) {
      if (!replyAiOpen) return;
      var t = ev && (ev.target || ev.srcElement);
      if (!isInsideReplyAi(t)) closeReplyAiMenu();
    };
    document.addEventListener('touchstart', onOutside, true);
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('click', onOutside, true);
  }

  function shortAiLabel(t) {
    return t === 'Claude Code' ? 'Claude' : t === 'Antigravity' ? 'Gemini' : t;
  }

  function replyIcon(name) {
    if (typeof icon === 'function' && typeof ICONS !== 'undefined' && ICONS[name]) return icon(name);
    var p = name === 'paperclip'
      ? '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'
      : name === 'mic'
        ? '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'
        : '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>';
    return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + p + '</svg>';
  }

  function replyBox(d) {
    // Um status curto: chega na hora (hook ouvindo, ou CLI livre) ou espera a sessão parar (fila)
    var isIdeAgy = d.tool === 'Gemini' && d.where === 'antigravity';
    var live = isIdeAgy
      ? !!d.listening
      : (d.tool === 'Codex' || d.tool === 'Ollama' || d.tool === 'Gemini'
        ? d.state !== 'working'
        : (!!d.listening || (d.state !== 'working' && /(?:^|:)[0-9a-f-]{36}$/.test(String(d.key || d.id || '')))));
    var rawSugg = d.suggestions && d.suggestions.length ? d.suggestions : [];
    var sugg = [], i;
    if (rawSugg.length) {
      sugg.push('Sim');
      for (i = 0; i < rawSugg.length; i++) {
        if (String(rawSugg[i] || '').toLowerCase() !== 'sim') sugg.push(rawSugg[i]);
      }
    }
    var html = '<div class="reply">';
    if (d.queued) html += '<div class="rqueued">Na fila: “' + esc(d.queued) + '” <button class="link" id="cancelReply">cancelar</button></div>';
    if (sugg.length) {
      html += '<div class="schips" id="suggChips">';
      for (i = 0; i < sugg.length; i++) html += '<button type="button" class="schip" data-chip="' + esc(sugg[i]) + '">' + esc(sugg[i]) + '</button>';
      html += '</div>';
    }
    html += '<div class="chips' + (chipsOpen ? ' open' : '') + '" id="quickChips">';
    for (i = 0; i < QUICK.length; i++) html += '<button type="button" class="chip" data-chip="' + esc(QUICK[i]) + '">' + esc(QUICK[i]) + '</button>';
    var curNorm = d.tool === 'Antigravity' ? 'Gemini' : d.tool;
    if (replyAiLastId !== d.id) {
      replyAiLastId = d.id;
      replyAiOpen = false;
    }
    var pickedTool = replyAiChoice[d.id] || curNorm;
    var isSwitchingAi = pickedTool !== curNorm;
    var aiOpts = ['Claude Code', 'Codex', 'Gemini', 'Ollama'];
    var aiPickerHtml = '';
    if (d.tool !== 'Ollama') {
      aiPickerHtml = '<div class="rai-wrap" id="replyAiWrap">' +
        '<button type="button" class="rai-btn' + (isSwitchingAi ? ' switching' : '') + '" id="replyAiBtn" aria-expanded="' + (replyAiOpen ? 'true' : 'false') + '" title="Trocar IA mantendo a mesma conversa">' +
        (isSwitchingAi ? '↪ ' : '') + esc(shortAiLabel(pickedTool)) + '<span class="rai-chev">▾</span></button>' +
        '<div class="rai-menu' + (replyAiOpen ? ' open' : '') + '" id="replyAiMenu">' +
        '<div class="rai-head">IA da próxima resposta</div>';
      for (i = 0; i < aiOpts.length; i++) {
        var optT = aiOpts[i], isSelOpt = optT === pickedTool, isCurOpt = optT === curNorm;
        aiPickerHtml += '<button type="button" class="rai-opt' + (isSelOpt ? ' sel' : '') + '" data-rait="' + esc(optT) + '">' +
          '<span>' + esc(optT) + '</span>' +
          '<span class="rai-tag">' + (isSelOpt ? '✓' : (isCurOpt ? 'atual' : '')) + '</span></button>';
      }
      aiPickerHtml += '</div></div>';
    }
    return html + '</div><div class="slash-pop" id="slashPop" style="display:none"></div>' +
      '<div class="rcomposer">' +
        '<div class="rform"><textarea id="replyText" rows="2" placeholder="Escreva, digite / ou fale uma resposta…"></textarea></div>' +
        '<div class="row rbar">' +
          '<input type="file" id="replyAttachInput" accept="image/*" style="display:none">' +
          '<button type="button" class="rtool attach" id="attachReply" aria-label="Anexar imagem" title="Anexar imagem">' + replyIcon('paperclip') + '</button>' +
          (Speech ? '<button type="button" class="rtool mic' + (rec ? ' on' : '') + '" id="micReply" aria-label="Falar a resposta" title="Falar a resposta">' + replyIcon('mic') + '</button>'
            : (snap && snap.voiceStt ? '<input type="file" id="voiceFileInput" accept="audio/*" capture="microphone" style="display:none"><button type="button" class="rtool mic" id="voiceSttBtn" aria-label="Ditar via Whisper local" title="Ditar via Whisper local">' + replyIcon('mic') + '</button>' : '')) +
          '<button type="button" class="qchips-btn' + (chipsOpen ? ' on' : '') + '" id="toggleChips" aria-expanded="' + (chipsOpen ? 'true' : 'false') + '">' +
            (sugg.length ? '⚡ Mais' : '⚡ Atalhos') + '</button>' +
          aiPickerHtml +
          '<span class="grow"></span>' +
          (live ? '<span class="rtag lo">● ao vivo</span>' : '<span class="rtag">na fila</span>') +
          '<button type="button" class="send" id="sendReply" aria-label="Enviar resposta" title="Enviar" disabled>' + replyIcon('arrowUp') + '</button>' +
        '</div>' +
      '</div></div>';
  }

  // ---- Ditado da resposta (Web Speech API do navegador ou Whisper local) ------
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

  function micState() { var b = $('micReply'); if (b) b.className = 'rtool mic' + (rec ? ' on' : ''); }

  function stopMic() { if (rec) try { rec.stop(); } catch (e) {} }

  function syncReplySendState() {
    var btn = $('sendReply'), box = $('replyText');
    if (!btn) return;
    var hasText = !!(box && String(box.value || '').replace(/^\s+|\s+$/g, '').length > 0);
    btn.disabled = !hasText;
  }

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
      syncReplySendState();
    };
    rec.onerror = function (e) {
      if (e.error === 'aborted') return;
      flash(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'Microfone bloqueado: permita o acesso no navegador.'
        : e.error === 'no-speech' ? 'Não ouvi nada. Toque no 🎤 e fale.' : 'Microfone indisponível (' + e.error + ').', false);
    };
    rec.onend = function () { rec = null; micState(); syncReplySendState(); };
    try { rec.start(); } catch (err) { rec = null; }
    micState();
  }

  function sendReply(d, text) {
    stopMic();
    if ($('sendReply')) $('sendReply').disabled = true;
    request('POST', '/api/reply', function (err, r) {
      if (err) { syncReplySendState(); return alert('Não enviado: ' + err.message); }
      if ($('replyText')) { $('replyText').value = ''; $('replyText').blur(); }
      syncReplySendState();
      if (r.sent) {
        flash(d.tool === 'Ollama' ? 'Enviado: o Ollama está gerando a resposta.'
          : d.tool === 'Gemini' ? 'Enviado ao Gemini.'
          : d.tool === 'Claude Code' ? 'Enviado ao Claude.' : 'Enviado ao Codex.');
        renderDetail(d);
        return;
      }
      d.queued = r.queued;
      d.listening = r.listening;
      renderDetail(d);
      if (r.queued) flash(r.listening ? 'Enviado: a sessão continua em instantes.' : 'Na fila: entra quando a sessão parar.');
    }, { key: d.key, text: text, tool: d.tool, id: d.id }); // id: o hub repassa ao PC dono da sessão
  }

  function bindReply(d) {
    if (!$('replyText')) return;
    syncReplySendState();
    if ($('toggleChips')) $('toggleChips').onclick = function () {
      chipsOpen = !chipsOpen;
      this.className = 'qchips-btn' + (chipsOpen ? ' on' : '');
      this.setAttribute('aria-expanded', chipsOpen ? 'true' : 'false');
      if ($('quickChips')) $('quickChips').className = 'chips' + (chipsOpen ? ' open' : '');
    };
    var chips = $('overlayBody').getElementsByTagName('button');
    for (var i = 0; i < chips.length; i++) {
      if (!chips[i].getAttribute('data-chip')) continue;
      chips[i].onclick = function () {
        $('replyText').value = this.getAttribute('data-chip');
        chipsOpen = false;
        if ($('toggleChips')) { $('toggleChips').className = 'qchips-btn'; $('toggleChips').setAttribute('aria-expanded', 'false'); }
        if ($('quickChips')) $('quickChips').className = 'chips';
        syncReplySendState();
      };
    }
    if ($('replyAiBtn') && $('replyAiMenu')) {
      bindReplyAiOutsideClose();
      $('replyAiBtn').onclick = function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        replyAiOpen = !replyAiOpen;
        this.setAttribute('aria-expanded', replyAiOpen ? 'true' : 'false');
        $('replyAiMenu').className = 'rai-menu' + (replyAiOpen ? ' open' : '');
      };
      var aiBtns = $('replyAiMenu').getElementsByTagName('button');
      for (var aiIdx = 0; aiIdx < aiBtns.length; aiIdx++) {
        aiBtns[aiIdx].onclick = function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          var picked = this.getAttribute('data-rait') || '';
          var curN = d.tool === 'Antigravity' ? 'Gemini' : d.tool;
          if (!picked || picked === curN) delete replyAiChoice[d.id];
          else replyAiChoice[d.id] = picked;
          replyAiOpen = false;
          var btn = $('replyAiBtn'), menu = $('replyAiMenu');
          var activeT = replyAiChoice[d.id] || curN;
          var sw = activeT !== curN;
          if (btn) {
            btn.className = 'rai-btn' + (sw ? ' switching' : '');
            btn.setAttribute('aria-expanded', 'false');
            btn.innerHTML = (sw ? '↪ ' : '') + esc(shortAiLabel(activeT)) + '<span class="rai-chev">▾</span>';
          }
          if (menu) {
            menu.className = 'rai-menu';
            var allO = menu.getElementsByTagName('button');
            for (var oi = 0; oi < allO.length; oi++) {
              var ot = allO[oi].getAttribute('data-rait') || '';
              var isSel = ot === activeT;
              allO[oi].className = 'rai-opt' + (isSel ? ' sel' : '');
              var tags = allO[oi].getElementsByTagName('span');
              if (tags.length > 1) tags[1].innerHTML = isSel ? '✓' : (ot === curN ? 'atual' : '');
            }
          }
          if (sw) flash('Próxima resposta será assumida por ' + activeT + '.');
        };
      }
    }
    $('sendReply').onclick = function () {
      var text = $('replyText').value.replace(/^\s+|\s+$/g, '');
      if (!text) return;
      var curNorm = d.tool === 'Antigravity' ? 'Gemini' : d.tool;
      var chosenTool = replyAiChoice[d.id] || curNorm;
      if (chosenTool && chosenTool !== curNorm) {
        stopMic();
        replyAiOpen = false;
        delete replyAiChoice[d.id];
        var btn = $('sendReply'), beforeIds = snapshotKnownIds();
        if (btn) btn.disabled = true;
        request('POST', '/api/handoff', function (err, r) {
          if (err) { syncReplySendState(); return alert('Troca de IA falhou: ' + err.message); }
          if ($('replyText')) { $('replyText').value = ''; $('replyText').blur(); }
          syncReplySendState();
          poll();
          flash(chosenTool + ' assumiu a conversa.');
          openPendingSessionDrawer({
            id: r && r.id ? r.id : '',
            tool: chosenTool,
            machine: (r && r.machine) || d.machine || '',
            cwd: d.cwd || '',
            project: d.project || '',
            prompt: text,
            beforeIds: beforeIds,
          });
        }, { id: d.id, targetTool: chosenTool, note: text });
        return;
      }
      sendReply(d, text);
    };
    if ($('cancelReply')) $('cancelReply').onclick = function () { sendReply(d, ''); };
    if ($('micReply')) $('micReply').onclick = toggleMic;
    // Anexo de imagem pelo celular/iPad -> POST /api/upload -> insere caminho no prompt
    if ($('attachReply') && $('replyAttachInput')) {
      $('attachReply').onclick = function () { $('replyAttachInput').click(); };
      $('replyAttachInput').onchange = function () {
        var f = this.files && this.files[0];
        if (!f || typeof FileReader === 'undefined') return;
        var btn = $('attachReply');
        if (btn) btn.disabled = true;
        var rd = new FileReader();
        rd.onload = function () {
          request('POST', '/api/upload', function (err, r) {
            if (btn) btn.disabled = false;
            if (err || !r || !r.path) return flash('Anexo falhou: ' + (err ? err.message : 'erro'), false);
            var box = $('replyText');
            if (box) {
              var cur = box.value ? box.value.replace(/\s+$/, '') + '\n' : '';
              box.value = cur + '[Imagem anexada: ' + r.path + '] ';
              box.focus();
              syncReplySendState();
            }
            flash('Imagem anexada (' + r.name + ').');
          }, { id: d.id, fileName: f.name || 'imagem.png', base64Data: String(rd.result || '') });
        };
        rd.readAsDataURL(f);
      };
    }
    // Autocomplete de `/` comandos e skills
    var slashList = null;
    function renderSlash(val) {
      var pop = $('slashPop');
      if (!pop) return;
      var m = /^\/([a-z0-9_-]*)$/i.exec(String(val || '').replace(/^\s+/, ''));
      if (!m || !slashList || !slashList.length) { pop.style.display = 'none'; pop.innerHTML = ''; return; }
      var q = m[1].toLowerCase(), out = '', n = 0, si;
      for (si = 0; si < slashList.length && n < 6; si++) {
        if (q && slashList[si].cmd.toLowerCase().indexOf('/' + q) !== 0 && slashList[si].name.toLowerCase().indexOf(q) < 0) continue;
        out += '<button type="button" class="slash-it" data-sc="' + esc(slashList[si].cmd) + '"><b>' + esc(slashList[si].cmd) + '</b>' +
          (slashList[si].description ? ' <small>' + esc(slashList[si].description) + '</small>' : '') + '</button>';
        n++;
      }
      if (!n) { pop.style.display = 'none'; pop.innerHTML = ''; return; }
      pop.innerHTML = out;
      pop.style.display = 'block';
      var sbs = pop.getElementsByTagName('button');
      for (si = 0; si < sbs.length; si++) {
        sbs[si].onclick = function () {
          var cmd = this.getAttribute('data-sc') || '';
          var chosenPrompt = '';
          for (var k = 0; slashList && k < slashList.length; k++) {
            if (slashList[k].cmd === cmd && slashList[k].prompt) { chosenPrompt = slashList[k].prompt; break; }
          }
          $('replyText').value = chosenPrompt ? chosenPrompt : (cmd + ' ');
          pop.style.display = 'none';
          $('replyText').focus();
          syncReplySendState();
        };
      }
    }
    $('replyText').oninput = function () {
      var v = this.value;
      syncReplySendState();
      if (v.charAt(0) !== '/') { renderSlash(''); return; }
      if (slashList) { renderSlash(v); return; }
      var sq = '/api/skills?cwd=' + encodeURIComponent(d.cwd || '') +
        (d.machine ? '&machine=' + encodeURIComponent(d.machine) : '') +
        (d.tool ? '&tool=' + encodeURIComponent(d.tool) : '');
      request('GET', sq, function (err, r) {
        if (!err && r && r.skills) { slashList = r.skills; renderSlash($('replyText') ? $('replyText').value : ''); }
      });
    };
    $('replyText').onchange = syncReplySendState;
    $('replyText').onkeyup = syncReplySendState;
    if ($('voiceSttBtn') && $('voiceFileInput')) {
      $('voiceSttBtn').onclick = function () { $('voiceFileInput').click(); };
      $('voiceFileInput').onchange = function () {
        var f = this.files && this.files[0];
        this.value = '';
        if (!f) return;
        var b = $('voiceSttBtn');
        b.disabled = true;
        b.innerHTML = '…';
        var rd = new FileReader();
        rd.onload = function () {
          request('POST', '/api/voice/transcribe', function (err, r) {
            b.disabled = false;
            b.innerHTML = replyIcon('mic');
            if (err) return flash('Transcrição falhou: ' + err.message, false);
            var box = $('replyText');
            if (box && r && r.text) {
              box.value = (box.value ? box.value.replace(/\s+$/, '') + ' ' : '') + r.text;
              box.focus();
              syncReplySendState();
            }
          }, { audioBase64: String(rd.result || ''), mimeType: f.type || 'audio/wav', language: 'pt' });
        };
        rd.onerror = function () { b.disabled = false; b.innerHTML = replyIcon('mic'); };
        rd.readAsDataURL(f);
      };
    }
  }

  function flash(msg, ok) {
    var el = $('rflash');
    if (!el) { el = document.createElement('div'); el.id = 'rflash'; document.body.appendChild(el); }
    el.innerHTML = esc(msg);
    el.className = ok === false ? 'show err' : 'show';
    setTimeout(function () { el.className = ''; }, 3000);
  }

  // Não redesenha a gaveta enquanto o usuário escreve, marca opções, configura Handoff ou lê prévia de arquivo
  function typing() {
    if (replyAiOpen) return true;
    var t = $('replyText');
    if (t && (t.value || document.activeElement === t || !!rec)) return true;
    if (typeof handoffUi !== 'undefined' && handoffUi && handoffUi.open) return true;
    if (typeof filePrev !== 'undefined' && filePrev && filePrev.open) return true;
    if (typeof memUi !== 'undefined' && memUi && memUi.open) return true;
    if (qState) {
      var qi, k2;
      for (qi in qState.others) if (qState.others[qi]) return true;
      for (qi in qState.sel) for (k2 in qState.sel[qi]) if (qState.sel[qi][k2]) return true;
    }
    var ae = document.activeElement;
    if (ae && (ae.id === 'sessAliasIn' || ae.id === 'sessGroupIn' || (ae.className && ae.className.indexOf('qother') >= 0))) return true;
    return false;
  }
