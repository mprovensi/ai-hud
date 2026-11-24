  // ---- Resposta rápida (hook-stop.js entrega à sessão parada) ----------------
  var QUICK = ['Sim', 'Continue', 'Sim, implemente', 'Resuma', 'Não, pare aqui', 'Faça o commit', 'Rode os testes', 'Explique melhor'];
  var chipsOpen = false;

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
    var html = '<div class="panel reply"><div class="row rhead"><h2 class="grow">Responder</h2>' +
      (live ? '<span class="rtag lo">● ao vivo</span>' : '<span class="rtag">vai para a fila</span>') +
      '<button type="button" class="qchips-btn' + (chipsOpen ? ' on' : '') + '" id="toggleChips" aria-expanded="' + (chipsOpen ? 'true' : 'false') + '">' +
      (sugg.length ? '⚡ Mais' : '⚡ Atalhos') + '</button></div>';
    if (d.tool === 'Ollama') html += '<div class="rnote">A resposta é gerada no Ollama e fica no HUD; não aparece no app do Ollama.</div>';
    if (isIdeAgy && !live && d.state !== 'working') html += '<div class="rnote">Sessão parada na IDE: Enviar entra na fila. Toque em <b>📱 Assumir</b> no topo para responder na hora pelo HUD.</div>';
    if (d.queued) html += '<div class="rqueued">Na fila: “' + esc(d.queued) + '” <button class="link" id="cancelReply">cancelar</button></div>';
    if (sugg.length) {
      html += '<div class="schips" id="suggChips">';
      for (i = 0; i < sugg.length; i++) html += '<button type="button" class="schip" data-chip="' + esc(sugg[i]) + '">' + esc(sugg[i]) + '</button>';
      html += '</div>';
    }
    html += '<div class="chips' + (chipsOpen ? ' open' : '') + '" id="quickChips">';
    for (i = 0; i < QUICK.length; i++) html += '<button type="button" class="chip" data-chip="' + esc(QUICK[i]) + '">' + esc(QUICK[i]) + '</button>';
    return html + '</div><div class="slash-pop" id="slashPop" style="display:none"></div>' +
      '<div class="row rform"><textarea id="replyText" rows="2" placeholder="Escreva, digite / ou fale uma resposta…"></textarea>' +
      '<input type="file" id="replyAttachInput" accept="image/*" style="display:none">' +
      '<button type="button" class="attach" id="attachReply" aria-label="Anexar imagem" title="Anexar imagem">📎</button>' +
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
    if ($('sendReply')) $('sendReply').disabled = true;
    request('POST', '/api/reply', function (err, r) {
      if (err) { if ($('sendReply')) $('sendReply').disabled = false; return alert('Não enviado: ' + err.message); }
      if ($('replyText')) { $('replyText').value = ''; $('replyText').blur(); }
      if (r.sent) {
        if ($('sendReply')) $('sendReply').disabled = false;
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
      };
    }
    $('sendReply').onclick = function () {
      var text = $('replyText').value.replace(/^\s+|\s+$/g, '');
      if (text) sendReply(d, text);
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
          $('replyText').value = this.getAttribute('data-sc') + ' ';
          pop.style.display = 'none';
          $('replyText').focus();
        };
      }
    }
    $('replyText').oninput = function () {
      var v = this.value;
      if (v.charAt(0) !== '/') { renderSlash(''); return; }
      if (slashList) { renderSlash(v); return; }
      request('GET', '/api/skills?cwd=' + encodeURIComponent(d.cwd || ''), function (err, r) {
        if (!err && r && r.skills) { slashList = r.skills; renderSlash($('replyText') ? $('replyText').value : ''); }
      });
    };
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
