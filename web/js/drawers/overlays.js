  function renderRecent() {
    if (!snap) return;
    var html = head('Sessões'), i, all = snap.active.concat(snap.recent);
    html += '<div class="panel">';
    for (i = 0; i < all.length; i++) html += sessRow(all[i], snap.now);
    setOverlay(html + '</div>');
  }

  function setOverlay(html) { $('overlayBody').innerHTML = html; $('back').onclick = closeOverlay; }

  // Abre na hora com o skeleton na mesma estrutura da gaveta (abas + conversa + responder)
  var detailCache = {};
  function quickDetail(id) {
    if (detailCache[id]) return renderDetail(detailCache[id]);
    var all = snap ? snap.active.concat(snap.recent) : [], x = null, i;
    for (i = 0; i < all.length; i++) if (all[i].id === id) x = all[i];
    var topHtml = x
      ? sessHead(x) + '<div class="dstate row">' + badge(x, snap.now) + '<span class="muted grow ell">' + dur(snap.now - x.start) + '</span>' +
        '<span class="sk sk-pill" style="width:6.5em;height:2em"></span></div>'
      : head('<span class="sk" style="width:7em;height:.9em"></span>', '<span class="sk" style="width:12em;height:.8em"></span>') +
        '<div class="dstate row"><span class="sk sk-pill" style="width:6em;height:1.4em"></span><span class="grow"></span><span class="sk sk-pill" style="width:6.5em;height:2em"></span></div>';
    var convoHtml = '<div class="panel convpanel"><div class="row chead"><h2 class="grow">Conversa</h2><span class="sk" style="width:3.5em;height:.8em"></span></div>' +
      '<div class="convo lastreply" id="lastReply" tabindex="-1">';
    if (x && x.lastPrompt) {
      convoHtml += '<div class="msg me"><div class="mtxt">' + esc(x.lastPrompt) + '</div></div>';
    } else {
      convoHtml += '<div class="msg me"><span class="sk sk-line" style="width:14em;margin-top:0"></span><span class="sk sk-line" style="width:9em"></span></div>';
    }
    if (x && x.lastReply) {
      convoHtml += '<div class="msg ai"><div class="mtxt">' + esc(x.lastReply) + '</div><span class="sk sk-line" style="width:65%;margin-top:8px"></span></div>';
    } else {
      convoHtml += '<div class="msg ai"><span class="sk sk-line" style="width:92%;margin-top:0"></span><span class="sk sk-line" style="width:84%"></span><span class="sk sk-line" style="width:60%"></span></div>';
    }
    convoHtml += '</div></div>';
    var replyHtml = (!x || x.where !== 'ollama-run')
      ? '<div class="panel reply"><div class="row rhead"><h2 class="grow">Responder</h2><span class="sk sk-pill" style="width:4.5em"></span></div>' +
        '<div class="schips"><span class="sk sk-pill" style="width:6.5em;height:2em;margin-right:6px"></span><span class="sk sk-pill" style="width:7.5em;height:2em;margin-right:6px"></span><span class="sk sk-pill" style="width:5.5em;height:2em"></span></div>' +
        '<div class="row rform"><span class="sk sk-input"></span><span class="sk sk-btn"></span></div></div>'
      : '';
    setOverlay(topHtml +
      '<div class="dtabs row" role="tablist"><button type="button" class="dtab active" disabled>Conversa</button><button type="button" class="dtab" disabled>Detalhes</button></div>' +
      convoHtml + replyHtml);
    if (x) rememberViewed(x);
  }

  function renderStartingSession(meta) {
    var m = meta || {};
    var idx = toolIndex(m.tool || 'Claude Code');
    var mach = snap && snap.machines && snap.machines.length > 1 && m.machine ? ' · 🖥 ' + esc(m.machine) : '';
    var title = m.tool ? toolIcon(idx) + esc(m.project || 'Nova sessão') + ' <small class="muted">' + esc(m.tool) + mach + '</small>' : 'Iniciando sessão…';
    var html = head(title, 'aguardando a IA iniciar a sessão') +
      '<div class="dstate row"><span class="badge working"><span class="pulse">●</span> iniciando sessão…</span><span class="muted grow ell">aguardando primeira resposta</span></div>' +
      '<div class="dtabs row" role="tablist"><button type="button" class="dtab active" disabled>Conversa</button><button type="button" class="dtab" disabled>Detalhes</button></div>' +
      '<div class="panel convpanel"><div class="row chead"><h2 class="grow">Conversa</h2></div><div class="convo lastreply">';
    if (m.prompt) html += '<div class="msg me"><div class="mtxt">' + esc(m.prompt) + '</div></div>';
    html += '<div class="mworking"><span class="pulse">●</span> iniciando processo e aguardando resposta…</div></div></div>';
    setOverlay(html);
  }

  function matchStartedSession(s, meta) {
    if (!s || !meta) return null;
    var all = (s.active || []).concat(s.recent || []), i, c;
    var multi = s.machines && s.machines.length > 1;
    for (i = 0; i < all.length; i++) {
      c = all[i];
      if (!c || (meta.beforeIds && meta.beforeIds[c.id])) continue;
      if (meta.tool && c.tool !== meta.tool) continue;
      if (multi && meta.machine && c.machine && c.machine !== meta.machine) continue;
      return c.id;
    }
    return null;
  }

  function checkPendingNewSession(s) {
    if (location.hash !== '#s=__starting__' || typeof pendingNewMeta === 'undefined' || !pendingNewMeta) return;
    var foundId = matchStartedSession(s, pendingNewMeta);
    if (foundId) {
      pendingNewId = foundId;
      pendingNewMeta.id = foundId;
      var nextHash = '#s=' + encodeURIComponent(foundId);
      if (typeof history !== 'undefined' && history && history.replaceState) {
        history.replaceState(null, '', nextHash);
        syncHash();
      } else {
        location.hash = nextHash;
      }
      return;
    }
    if (new Date().getTime() >= pendingNewUntil) {
      pendingNewId = '';
      pendingNewMeta = null;
      setOverlay(head('Sessão iniciada') + '<div class="panel"><p class="empty">A sessão ainda não apareceu no histórico. Feche para conferir na lista ou aguarde mais alguns instantes.</p></div>');
    }
  }

  function loadDetail() {
    var m = /^#s=(.+)$/.exec(location.hash);
    if (!m) return;
    var id = decodeURIComponent(m[1]);
    if (id === '__starting__') {
      var meta = typeof pendingNewMeta !== 'undefined' ? pendingNewMeta : null;
      var found = snap && meta ? matchStartedSession(snap, meta) : null;
      if (found) { checkPendingNewSession(snap); return; }
      if (meta && new Date().getTime() < pendingNewUntil) {
        renderStartingSession(meta);
        setTimeout(function () { if (location.hash === '#s=__starting__') { poll(); loadDetail(); } }, 1500);
        return;
      }
      pendingNewId = '';
      pendingNewMeta = null;
      return setOverlay(head('Sessão') + '<div class="panel"><p class="empty">Sessão iniciada, mas ainda sem resposta registrada.</p></div>');
    }
    request('GET', '/api/session?id=' + encodeURIComponent(id), function (err, d) {
      if (location.hash !== '#s=' + encodeURIComponent(id)) return;
      if (err) {
        if (err.status === 404 && typeof pendingNewId !== 'undefined' && id === pendingNewId && new Date().getTime() < pendingNewUntil) {
          renderStartingSession(typeof pendingNewMeta !== 'undefined' ? pendingNewMeta : null);
          setTimeout(loadDetail, 1200);
          return;
        }
        return setOverlay(head('Sessão') + '<p class="empty">' + esc(err.message) + '</p>');
      }
      if (typeof pendingNewId !== 'undefined' && id === pendingNewId) { pendingNewId = ''; pendingNewMeta = null; }
      // Se abriu por UUID curto (ex.: Codex recém-criado), alinha a URL e o cache ao id completo do cartão
      if (d && d.id && d.id !== id) {
        id = d.id;
        if (typeof history !== 'undefined' && history && history.replaceState) {
          history.replaceState(null, '', '#s=' + encodeURIComponent(id));
        }
      }
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
    var usage = /^#uso=(claude|codex|gemini)$/.exec(h);
    usageName = usage ? usage[1] : null;
    view = /^#s=/.test(h) ? 'detail' : h === '#recentes' ? 'recent' : h === '#estatisticas' ? 'stats' : h === '#ollama' ? 'ollama' : h === '#nova' ? 'new' : usage ? 'usage' : null;
    $('overlay').className = $('backdrop').className = view ? 'show' : '';
    if (view) {
      $('overlay').scrollTop = 0;
      if ($('overlay').focus) { try { $('overlay').focus({ preventScroll: true }); } catch (e) { try { $('overlay').focus(); } catch (e2) {} } }
    } else {
      detailFocusedId = '';
      if (snap) render(snap); // o fundo não é redesenhado com a gaveta aberta
    }
    if (view === 'detail') {
      var sid = decodeURIComponent(h.slice(3));
      if (sid === '__starting__') renderStartingSession(typeof pendingNewMeta !== 'undefined' ? pendingNewMeta : null);
      else quickDetail(sid);
      loadDetail();
    }
    if (view === 'recent') renderRecent();
    if (view === 'new') openNewSession();
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
  $('openNew').onclick = function () { location.hash = 'nova'; };
  if ($('openWorkspace')) $('openWorkspace').onclick = function () { location.href = '/workspace' + (token ? '?t=' + encodeURIComponent(token) : ''); };
  $('openRecent').onclick = function () { location.hash = 'recentes'; };
  $('openStats').onclick = function () { location.hash = 'estatisticas'; };
  $('q-ollama').onclick = function () { location.hash = 'ollama'; };
  $('q-claude').onclick = function () { location.hash = 'uso=claude'; };
  $('q-codex').onclick = function () { location.hash = 'uso=codex'; };
  $('q-gemini').onclick = function () { location.hash = 'uso=gemini'; };
  function panelKey(e) { if (e.keyCode === 13 || e.keyCode === 32) { e.preventDefault(); this.onclick(); } }
  $('q-claude').onkeydown = $('q-codex').onkeydown = $('q-gemini').onkeydown = $('q-ollama').onkeydown = panelKey;
  $('backdrop').onclick = closeOverlay;

