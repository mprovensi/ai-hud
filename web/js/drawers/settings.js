  // ---- Configurações (gaveta #configuracoes: som, leitura e digital no celular) ----
  function renderSettings() {
    var html = head('Configurações', 'preferências deste aparelho');

    // Alertas sonoros
    html += '<div class="panel cfg-panel">' +
      '<h2>Alertas</h2>' +
      '<p class="cfg-desc">Avisa com som quando uma sessão espera resposta ou uma cota está acabando.</p>' +
      '<div class="cfg-row">' +
        '<button type="button" class="btn cfg-toggle' + (soundOn ? ' on' : '') + '" id="cfgSound" aria-pressed="' + (soundOn ? 'true' : 'false') + '">' +
          icon(soundOn ? 'bell' : 'bellOff') + '<span>' + (soundOn ? 'Som ligado' : 'Som desligado') + '</span>' +
        '</button>' +
      '</div></div>';

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

    if ($('cfgSound')) {
      $('cfgSound').onclick = function () {
        unlockAudio();
        setSound(!soundOn);
        if (soundOn) beep();
        renderSettings();
      };
    }
    bindReadingButtons();
    if (typeof bioBindSettings === 'function') bioBindSettings();
  }
