  function renderRecent() {
    if (!snap) return;
    var html = head('Sessões'), i, all = snap.active.concat(snap.recent);
    html += '<div class="panel">';
    for (i = 0; i < all.length; i++) html += sessRow(all[i], snap.now);
    setOverlay(html + '</div>');
  }

  function setOverlay(html) { $('overlayBody').innerHTML = html; $('back').onclick = closeOverlay; }

  // Abre na hora com o que o snapshot já tem; os números completos chegam em seguida
  var detailCache = {};
  function quickDetail(id) {
    if (detailCache[id]) return renderDetail(detailCache[id]);
    var all = snap ? snap.active.concat(snap.recent) : [], x = null, i;
    for (i = 0; i < all.length; i++) if (all[i].id === id) x = all[i];
    if (!x) return setOverlay(head('Sessão') + '<p class="empty">carregando…</p>');
    setOverlay(sessHead(x) + '<div class="dstate">' + badge(x, snap.now) + '</div>' +
      (x.lastPrompt ? '<div class="panel"><h2>Seu último pedido</h2><div class="quote">' + esc(x.lastPrompt) + '</div></div>' : '') +
      '<p class="empty">carregando detalhes…</p>');
    rememberViewed(x);
  }

  function loadDetail() {
    var m = /^#s=(.+)$/.exec(location.hash);
    if (!m) return;
    var id = decodeURIComponent(m[1]);
    request('GET', '/api/session?id=' + encodeURIComponent(id), function (err, d) {
      if (location.hash !== '#s=' + encodeURIComponent(id)) return;
      if (err) return setOverlay(head('Sessão') + '<p class="empty">' + esc(err.message) + '</p>');
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
    var usage = /^#uso=(claude|codex)$/.exec(h);
    usageName = usage ? usage[1] : null;
    view = /^#s=/.test(h) ? 'detail' : h === '#recentes' ? 'recent' : h === '#estatisticas' ? 'stats' : h === '#ollama' ? 'ollama' : usage ? 'usage' : null;
    $('overlay').className = $('backdrop').className = view ? 'show' : '';
    if (view) $('overlay').scrollTop = 0;
    else if (snap) render(snap); // o fundo não é redesenhado com a gaveta aberta
    if (view === 'detail') { quickDetail(decodeURIComponent(h.slice(3))); loadDetail(); }
    if (view === 'recent') renderRecent();
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
  $('openRecent').onclick = function () { location.hash = 'recentes'; };
  $('openStats').onclick = function () { location.hash = 'estatisticas'; };
  $('q-ollama').onclick = function () { location.hash = 'ollama'; };
  $('q-claude').onclick = function () { location.hash = 'uso=claude'; };
  $('q-codex').onclick = function () { location.hash = 'uso=codex'; };
  function panelKey(e) { if (e.keyCode === 13 || e.keyCode === 32) { e.preventDefault(); this.onclick(); } }
  $('q-claude').onkeydown = $('q-codex').onkeydown = $('q-ollama').onkeydown = panelKey;
  $('backdrop').onclick = closeOverlay;

