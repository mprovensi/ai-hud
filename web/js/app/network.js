  // ---- Rede ----------------------------------------------------------------
  function request(method, url, done, body, timeout) {
    var x = new XMLHttpRequest(), finished = false;
    function finish(err, data, text) { if (finished) return; finished = true; done(err, data, text); }
    function networkError(message) {
      var err = new Error(message); err.offline = true; err.status = 0; finish(err);
    }
    x.open(method, url + (token ? (url.indexOf('?') < 0 ? '?' : '&') + 't=' + token : ''), true);
    x.timeout = timeout || 60000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || x.status === 0) return;
      if (x.status === 200) {
        var data;
        try { data = JSON.parse(x.responseText); } catch (e) { var invalid = new Error('resposta inválida do servidor'); invalid.status = 200; finish(invalid); return; }
        finish(null, data, x.responseText); return;
      }
      var err = new Error(x.status === 401 ? 'sessão expirada: entre novamente' : x.status === 403 ? 'acesso não permitido' : x.status === 404 ? 'sessão não encontrada' : x.status === 429 ? 'aguarde antes de atualizar novamente' : x.status >= 500 ? 'erro do servidor (HTTP ' + x.status + ')' : 'falha na consulta (HTTP ' + x.status + ')');
      if (x.status >= 400 && x.status < 500 && x.status !== 401 && x.status !== 403 && x.status !== 429 && x.responseText && x.responseText.charAt(0) !== '<') err.message = x.responseText.slice(0, 300);
      err.status = x.status;
      finish(err);
    };
    x.onerror = function () { networkError('sem conexão com o servidor'); };
    x.ontimeout = function () { networkError('o servidor não respondeu a tempo'); };
    x.onabort = function () { networkError('consulta interrompida'); };
    if (body) x.setRequestHeader('Content-Type', 'application/json');
    try { x.send(body ? JSON.stringify(body) : null); } catch (e) { networkError('não foi possível conectar ao servidor'); }
  }

  // O iPad mini 1 é lento para redesenhar: só quando os dados mudaram, e não com a gaveta aberta
  var lastText = '';
  function apply(err, s, text) {
    if (!err && (!s || typeof s.now !== 'number' || !Array.isArray(s.active) || !Array.isArray(s.recent) || !s.quotas || !s.today)) err = new Error('resposta inválida do servidor');
    if (err) {
      connection = { kind: err.status === 401 ? 'auth' : err.offline ? 'network' : 'server', message: err.message };
    }
    if (err && err.offline) {
      // Wi-Fi instável (iPad antigo) perde um pedido de vez em quando: só mostra a tela de
      // desconectado na 2ª falha seguida; na 1ª, tenta de novo em ~3 s sem alarde
      failures++;
      if (failures >= 2) setOffline(true);
      lastAttempt = new Date().getTime() - (offline ? RETRY_MS : POLL_MS) + 3000;
      paintConnection(new Date().getTime());
      return;
    }
    if (err) { failures = 0; setOffline(connection.kind === 'auth'); paintConnection(new Date().getTime()); return; }
    failures = 0;
    connection = { kind: 'live', message: '' };
    setOffline(false);
    lastOk = new Date().getTime();
    if (s && s.now) skew = s.now - lastOk;
    if (s && typeof s.tz === 'number') tzMs = s.tz * 60000;
    paintConnection(lastOk);
    if (s.appVersion && s.appVersion !== APP_VERSION) $('updateNotice').style.display = 'block';
    text = (text || '').replace(/^\{"now":\d+/, ''); // "now" muda sempre; o resto diz se algo mudou
    if (text && text === lastText) return;
    lastText = text;
    var first = !snap;
    snap = s;
    checkAlerts(s);
    if (first || !view) return render(s); // a primeira vez desenha o fundo mesmo com gaveta aberta
    if (view === 'stats') renderStats();
    if (view === 'usage') renderUsage();
    if (view === 'ollama') renderOllama();
    if (view === 'recent') renderRecent();
  }

  // ---- Desconectado: tela própria e nova tentativa a cada 5 s (conectado: a cada 10 s) ----
  var offline = false, inFlight = false, lastAttempt = 0, failures = 0;
  var POLL_MS = 10000, RETRY_MS = 5000;
  var connection = { kind: 'loading', message: '' }, refreshBusy = false;

  function paintConnection(t) {
    var ago = lastOk ? Math.max(0, Math.round((t - lastOk) / 1000)) : 0;
    var kind = connection.kind, label, color = 'hi';
    if (kind === 'auth') label = 'entrar novamente';
    else if (kind === 'network') label = 'sem conexão';
    else if (kind === 'server') label = 'falha na atualização';
    else if (kind === 'loading') { label = 'conectando…'; color = 'warn'; }
    else if (ago > 40) { label = 'dados sem atualização'; color = 'warn'; }
    else if (refreshBusy) { label = 'lendo cotas…'; color = 'warn'; }
    else { label = 'ao vivo'; color = 'lo'; }
    var html = '<span class="' + color + '">● ' + label + '</span>';
    if ($('status').innerHTML !== html) $('status').innerHTML = html;
    $('status').setAttribute('data-state', kind);
    var info = connection.message ? connection.message + '. ' : '';
    info += lastOk ? (kind === 'live' && ago <= 40 ? 'Última atualização às ' : 'Exibindo dados recebidos às ') + hm(lastOk + skew) + '.' : 'Aguardando a primeira atualização.';
    if ($('connectionInfo').textContent !== info) $('connectionInfo').textContent = info;
  }

  function setOffline(on) {
    offline = on;
    $('offline').className = on ? 'show' : '';
    $('offlineTitle').textContent = connection.kind === 'auth' ? 'Entre novamente no AI HUD' : 'Sem conexão com o servidor';
    $('offlineMessage').textContent = connection.kind === 'auth' ? 'Sua sessão não é mais válida. Digite o PIN novamente para continuar.' : 'Confira a rede, a conexão do Tailscale e se o AI HUD está rodando no PC.';
    $('loginAgain').style.display = connection.kind === 'auth' ? 'inline-block' : 'none';
    $('oretryNow').style.display = connection.kind === 'auth' ? 'none' : 'inline-block';
    $('oretry').style.display = connection.kind === 'auth' ? 'none' : 'block';
    if (on) $('olast').innerHTML = lastOk ? 'Últimos dados recebidos às ' + hm(lastOk + skew) + '.' : '';
  }

  // Versão do snapshot (servidores novos): com ela o servidor segura a consulta até algo mudar (máx. 25 s)
  // e a próxima sai logo em seguida. Servidor antigo (sem versão) ou conexão instável: consulta a cada 10 s.
  var version = null;

  function poll() {
    if (inFlight || connection.kind === 'auth') return;
    inFlight = true;
    lastAttempt = new Date().getTime();
    var waiting = !!version && connection.kind === 'live' && !offline;
    var url = waiting ? '/api/snapshot?desde=' + encodeURIComponent(version) + '&espera=25' : '/api/snapshot';
    // Sem espera, prazo curto: com o servidor fora, a tela de desconectado aparece em segundos
    request('GET', url, function (err, s, text) {
      inFlight = false;
      version = !err && s && s.version ? s.version : null;
      if (version) lastAttempt = new Date().getTime() - POLL_MS; // o servidor é quem espera: pergunta de novo já
      apply(err, s, text);
    }, null, waiting ? 35000 : 8000);
    if (view === 'detail' && !offline && connection.kind === 'live') loadDetail();
  }

  // Relógio, status e agenda das consultas, a cada segundo
  function tick() {
    var t = new Date().getTime();
    $('clock').innerHTML = hm(t + skew);
    paintConnection(t);
    var wait = (offline ? RETRY_MS : POLL_MS) - (t - lastAttempt);
    if (wait <= 0 && connection.kind !== 'auth') poll();
    if (offline && connection.kind !== 'auth') {
      $('oretry').innerHTML = inFlight ? '<span class="pulse">●</span> Tentando reconectar…'
        : 'Nova tentativa em ' + Math.max(1, Math.ceil(wait / 1000)) + 's';
    }
  }

