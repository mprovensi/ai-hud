  // ---- Configurações (gaveta #configuracoes: som, push, leitura e digital no celular) ----
  function pushSupported() {
    var proto = (typeof location !== 'undefined' && location.protocol) || '';
    var host = (typeof location !== 'undefined' && location.hostname) || '';
    var secure = proto === 'https:' || host === 'localhost' || host === '127.0.0.1';
    return secure && typeof navigator !== 'undefined' && 'serviceWorker' in navigator &&
      typeof window !== 'undefined' && 'PushManager' in window && typeof Notification !== 'undefined';
  }

  function urlBase64ToUint8(str) {
    var pad = '='.repeat ? '='.repeat((4 - (str.length % 4)) % 4) : (new Array(((4 - (str.length % 4)) % 4) + 1).join('='));
    var base64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64), out = new Uint8Array(raw.length), i;
    for (i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function bindPushSettings() {
    if (!pushSupported() || !$('cfgPushBtn')) return;
    var btn = $('cfgPushBtn'), testBtn = $('cfgPushTest'), stEl = $('cfgPushState');
    var currentSub = null;
    function refreshBtn(sub) {
      currentSub = sub;
      if (btn) {
        btn.disabled = false;
        btn.className = 'btn cfg-toggle' + (sub ? ' on' : '');
        btn.textContent = sub ? '🔔 Notificações Push ativas' : 'Ativar notificações Push';
      }
      if (testBtn) testBtn.style.display = sub ? '' : 'none';
      if (stEl) stEl.textContent = sub
        ? 'Ativo: você será avisado em segundo plano quando a IA terminar, pedir permissão, falhar teste ou concluir Dreaming.'
        : 'Receba notificações nativas mesmo com o app fechado (requer HTTPS / Tailscale Serve).';
    }
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(refreshBtn).catch(function () { refreshBtn(null); });

    btn.onclick = function () {
      btn.disabled = true;
      if (currentSub) {
        var ep = currentSub.endpoint;
        currentSub.unsubscribe().then(function () {
          request('POST', '/api/push/unsubscribe', function () {
            flash('Notificações Push desativadas.');
            refreshBtn(null);
          }, { endpoint: ep });
        }).catch(function () { btn.disabled = false; });
        return;
      }
      Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') {
          btn.disabled = false;
          return flash('Permissão de notificação negada no navegador.', false);
        }
        request('GET', '/api/push/public-key', function (err, info) {
          if (err || !info || !info.publicKey) {
            btn.disabled = false;
            return flash('Não foi possível obter a chave VAPID.', false);
          }
          navigator.serviceWorker.ready.then(function (reg) {
            return reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8(info.publicKey),
            });
          }).then(function (sub) {
            var json = sub.toJSON ? sub.toJSON() : sub;
            request('POST', '/api/push/subscribe', function (sErr) {
              if (sErr) { btn.disabled = false; return flash('Falha ao salvar assinatura: ' + sErr.message, false); }
              flash('Notificações Push ativadas!');
              refreshBtn(sub);
            }, { endpoint: json.endpoint, keys: json.keys, label: (navigator.userAgent || '').slice(0, 50) });
          }).catch(function (e) {
            btn.disabled = false;
            flash('Falha ao ativar Push: ' + (e && e.message ? e.message : 'erro'), false);
          });
        });
      });
    };

    if (testBtn) {
      testBtn.onclick = function () {
        testBtn.disabled = true;
        request('POST', '/api/push/test', function (err, r) {
          testBtn.disabled = false;
          if (err) return flash('Falhou: ' + err.message, false);
          flash(r && r.sent ? 'Notificação de teste enviada!' : 'Nenhuma assinatura ativa respondeu.', !!(r && r.sent));
        }, {});
      };
    }
  }

  function renderSettings() {
    var html = head('Configurações', 'preferências deste aparelho');

    // Modo remoto (padrão ligado: encaminha pedidos de permissão do Claude Code para o HUD)
    var remoteOn = !snap || snap.remoteMode !== false;
    html += '<div class="panel cfg-panel">' +
      '<h2>Modo remoto</h2>' +
      '<p class="cfg-desc">Ligado por padrão: encaminha pedidos de permissão para o AI HUD.</p>' +
      '<div class="cfg-row">' +
        '<button type="button" class="btn cfg-toggle' + (remoteOn ? ' on' : '') + '" id="cfgRemote" aria-pressed="' + (remoteOn ? 'true' : 'false') + '">' +
          '<span>' + (remoteOn ? '📡 Modo remoto ligado' : 'Modo remoto desligado') + '</span>' +
        '</button>' +
      '</div></div>';

    // Alertas sonoros
    html += '<div class="panel cfg-panel">' +
      '<h2>Alertas</h2>' +
      '<p class="cfg-desc">Avisa com som quando uma sessão espera resposta ou pede permissão.</p>' +
      '<div class="cfg-row">' +
        '<button type="button" class="btn cfg-toggle' + (soundOn ? ' on' : '') + '" id="cfgSound" aria-pressed="' + (soundOn ? 'true' : 'false') + '">' +
          icon(soundOn ? 'bell' : 'bellOff') + '<span>' + (soundOn ? 'Som ligado' : 'Som desligado') + '</span>' +
        '</button>' +
      '</div></div>';

    // Notificações Web Push nativas (Android PWA / Desktop HTTPS; oculto no Safari 9 / iPad mini 1)
    if (pushSupported()) {
      html += '<div class="panel cfg-panel">' +
        '<h2>Notificações Push</h2>' +
        '<p class="cfg-desc" id="cfgPushState">Verificando suporte a notificações em segundo plano…</p>' +
        '<div class="cfg-row cfg-actions">' +
          '<button type="button" class="btn cfg-toggle" id="cfgPushBtn" disabled>Carregando…</button>' +
          '<button type="button" class="btn" id="cfgPushTest" style="display:none">Testar notificação</button>' +
        '</div></div>';
    }

    // Tamanho da leitura
    html += '<div class="panel cfg-panel">' +
      '<h2>Tamanho da leitura</h2>' +
      '<p class="cfg-desc">Ajusta o tamanho da fonte nesta tela.</p>' +
      '<div class="cfg-group" role="group" aria-label="Tamanho da leitura">' +
        '<button type="button" class="btn cfg-opt" id="textNormal" aria-pressed="' + (readingSize === 'normal' ? 'true' : 'false') + '">Normal</button>' +
        '<button type="button" class="btn cfg-opt" id="textLarge" aria-pressed="' + (readingSize === 'large' ? 'true' : 'false') + '">Grande</button>' +
        '<button type="button" class="btn cfg-opt" id="textLarger" aria-pressed="' + (readingSize === 'larger' ? 'true' : 'false') + '">Maior</button>' +
      '</div></div>';

    // Bloqueio por digital: exibido somente no celular (oculto no iPad e no Desktop)
    if (typeof bioCanShow === 'function' && bioCanShow()) {
      html += '<div class="panel cfg-panel" id="cfgBioPanel">' +
        '<h2>Impressão digital</h2>' +
        '<p class="cfg-desc" id="bioStateText">' + esc(bioActive
          ? 'Digital ativa · bloqueia ao abrir o app ou após ' + bioTimeoutLabel(bioTimeoutMs) + ' em segundo plano.'
          : 'Exige sua digital ao abrir o AI HUD neste celular. iPad e Desktop não são afetados.') + '</p>';
      if (!bioActive) {
        html += '<div class="cfg-row">' +
          '<button type="button" class="btn cfg-primary" id="bioEnable">' + icon('fingerprint') + '<span>Ativar digital neste celular</span></button>' +
        '</div>';
      } else {
        html += '<div class="cfg-sub">Bloquear após ficar em segundo plano</div>' +
          '<div class="cfg-group" role="group" aria-label="Tempo de bloqueio">' +
            '<button type="button" class="btn cfg-opt" id="bioT0" aria-pressed="' + (bioTimeoutMs === 0 ? 'true' : 'false') + '">Imediato</button>' +
            '<button type="button" class="btn cfg-opt" id="bioT60000" aria-pressed="' + (bioTimeoutMs === 60000 ? 'true' : 'false') + '">1 min</button>' +
            '<button type="button" class="btn cfg-opt" id="bioT120000" aria-pressed="' + (bioTimeoutMs === 120000 ? 'true' : 'false') + '">2 min</button>' +
            '<button type="button" class="btn cfg-opt" id="bioT300000" aria-pressed="' + (bioTimeoutMs === 300000 ? 'true' : 'false') + '">5 min</button>' +
          '</div>' +
          '<div class="cfg-row cfg-actions">' +
            '<button type="button" class="btn" id="bioLockNow">Trancar agora</button>' +
            '<button type="button" class="btn bio-danger" id="bioDisable">Desativar digital</button>' +
          '</div>';
      }
      html += '</div>';
    }

    html += '<p class="cfg-foot muted">AI HUD · versão ' + esc(APP_VERSION) + '</p>';
    setOverlay(html);

    if ($('cfgRemote')) {
      $('cfgRemote').onclick = function () {
        var b = this, next = !(!snap || snap.remoteMode !== false);
        b.disabled = true;
        request('POST', '/api/remote', function (err, r) {
          b.disabled = false;
          if (err) return flash('Falhou: ' + err.message, false);
          if (snap) snap.remoteMode = !!(r && r.remoteMode);
          flash(next ? 'Modo remoto ligado.' : 'Modo remoto desligado.');
          renderSettings();
        }, { on: next });
      };
    }
    if ($('cfgSound')) {
      $('cfgSound').onclick = function () {
        unlockAudio();
        setSound(!soundOn);
        if (soundOn) beep();
        renderSettings();
      };
    }
    bindReadingButtons();
    bindPushSettings();
    if (typeof bioBindSettings === 'function') bioBindSettings();
  }
