  setSound(soundOn);
  $('openStats').innerHTML = icon('stats') + '<span class="lbl"> Estatísticas</span>';
  $('openRecent').innerHTML = icon('recent') + '<span class="lbl"> Recentes</span>';
  $('reading').innerHTML = icon('text');
  $('refresh').innerHTML = icon('refresh');
  setRemoteBtn(false);

  // Modo remoto: pedidos de permissão do Claude esperam Permitir/Negar aqui em vez de aparecer no PC
  $('remote').onclick = function () {
    var on = !(snap && snap.remoteMode);
    if (on && !confirm('Ligar o modo remoto?\n\nPedidos de permissão do Claude vão esperar sua resposta aqui (até 10 min) em vez de aparecer no PC. Use quando estiver longe do computador.')) return;
    request('POST', '/api/remote', function (err, r) {
      if (err) return flash('Falhou: ' + err.message, false);
      if (snap) snap.remoteMode = r.remoteMode;
      setRemoteBtn(r.remoteMode);
      flash(r.remoteMode ? 'Modo remoto ligado.' : 'Modo remoto desligado: permissões voltam para o PC.');
    }, { on: on });
  };
  $('sound').onclick = function () { unlockAudio(); setSound(!soundOn); if (soundOn) beep(); };

  $('refresh').onclick = function () {
    if (refreshBusy || connection.kind === 'auth') return;
    refreshBusy = true;
    paintConnection(new Date().getTime());
    request('POST', '/api/refresh', function (err, s, text) { refreshBusy = false; apply(err, s, text); });
  };
  $('loginAgain').onclick = function () { location.href = '/'; };
  $('applyUpdate').onclick = function () {
    if (typing() && !confirm('Há uma resposta em edição. Atualizar o app descarta esse texto. Continuar?')) return;
    location.reload(true);
  };

  // App instalado no Android que abriu sem tela cheia (o Chrome às vezes ignora o "fullscreen" do
  // manifest): o primeiro toque pede tela cheia. Não vale no navegador nem no iPad (sem display-mode).
  // Pela rede em http o Chrome nem instala como app (só em HTTPS): o atalho abre como aba comum.
  var installed = window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: minimal-ui)').matches);
  var rootEl = document.documentElement, enterFs = rootEl.requestFullscreen || rootEl.webkitRequestFullscreen;
  if (installed && enterFs) {
    var goFull = function () {
      document.removeEventListener('touchend', goFull, false);
      try { var p = enterFs.call(rootEl); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    };
    document.addEventListener('touchend', goFull, false);
  }

  window.addEventListener('resize', function () { if (snap) burnChart(snap, view === 'usage' ? usageName : null); });
  $('oretryNow').onclick = function () { poll(); tick(); };
  syncHash(); poll(); tick();
  setInterval(tick, 1000);
  // Ao voltar do bloqueio de tela o iOS congela timers; atualiza na hora
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  // PWA: só em HTTPS/localhost (Chrome no Android via Tailscale); o iOS 9 não tem service worker
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
