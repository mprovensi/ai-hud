  // ---- Bloqueio por impressão digital (WebAuthn), opcional e exclusivo para o AI HUD no celular ----
  // ES5 puro: iPad mini 1 / Safari 9 ignora este módulo sem erro nem requisições extras.
  var bioLocked = false;
  var bioActive = false;
  var bioTimeoutMs = 120000;
  var bioHiddenAt = 0;
  var bioBusy = false;

  function bioStore(key, val) { return store(key, val); }
  function bioSession(key, val) {
    try {
      if (val === undefined) return window.sessionStorage ? sessionStorage.getItem(key) : null;
      if (val === null) { if (window.sessionStorage) sessionStorage.removeItem(key); return; }
      if (window.sessionStorage) sessionStorage.setItem(key, val);
    } catch (e) {}
    return null;
  }
  function bioRemoveStore(key) { try { if (window.localStorage) localStorage.removeItem(key); } catch (e) {} }

  function bioIsMobilePhone() {
    var ua = (navigator && navigator.userAgent) || '';
    if (/iPad/i.test(ua)) return false;
    if (/Android/i.test(ua) && /Mobile/i.test(ua)) return true;
    if (/iPhone|iPod/i.test(ua)) return true;
    return false;
  }

  function bioSecureOrigin() {
    if (!location) return false;
    if (location.protocol === 'https:') return true;
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  function bioSupported() {
    return !!(typeof window !== 'undefined' && window.PublicKeyCredential && navigator && navigator.credentials && typeof fetch === 'function' && typeof Promise === 'function' && bioSecureOrigin());
  }

  function bioB64uToBuf(s) {
    var norm = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (norm.length % 4) norm += '=';
    var bin = atob(norm);
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }

  function bioBufToB64u(buf) {
    var u = new Uint8Array(buf), s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function bioConsumeFreshCookie() {
    try {
      var c = (document && document.cookie) || '';
      if (/(?:^|;\s*)hud_bio_fresh=1(?:;|$)/.test(c)) {
        document.cookie = 'hud_bio_fresh=; Max-Age=0; Path=/; SameSite=Lax';
        bioSession('hud.bio.ok', '1');
        return true;
      }
    } catch (e) {}
    return false;
  }

  function bioTimeoutLabel(ms) {
    if (ms === 0) return 'imediato';
    return Math.round(ms / 60000) + ' min';
  }

  function bioCanShow() {
    return bioSupported() && (bioIsMobilePhone() || bioActive);
  }

  function bioBindSettings() {
    if ($('bioEnable')) $('bioEnable').onclick = bioEnable;
    if ($('bioLockNow')) $('bioLockNow').onclick = function () { bioLockNow(false); };
    if ($('bioDisable')) $('bioDisable').onclick = bioDisable;
    var times = [0, 60000, 120000, 300000];
    for (var i = 0; i < times.length; i++) {
      (function (ms) {
        var el = $('bioT' + ms);
        if (el) el.onclick = function () { bioSetTimeout(ms); };
      })(times[i]);
    }
  }

  function bioPaintControls() {
    if (view === 'settings' && typeof renderSettings === 'function') renderSettings();
  }

  function bioShowLock(autoPrompt, message) {
    bioLocked = true;
    bioSession('hud.bio.ok', null);
    if ($('bioLockMsg')) $('bioLockMsg').textContent = message || '';
    if ($('bioPinForm')) $('bioPinForm').className = '';
    if ($('bioLock')) $('bioLock').className = 'show';
    if (autoPrompt) setTimeout(function () { bioUnlock(); }, 120);
  }

  function bioHideLock() {
    bioLocked = false;
    bioHiddenAt = 0;
    bioSession('hud.bio.hiddenAt', null);
    bioSession('hud.bio.ok', '1');
    if ($('bioLock')) $('bioLock').className = '';
    if ($('bioLockMsg')) $('bioLockMsg').textContent = '';
  }

  function bioSendLockBeacon() {
    try {
      if (navigator && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon('/auth/webauthn/lock', '');
        return;
      }
    } catch (e) {}
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/auth/webauthn/lock', true);
      x.send('');
    } catch (e) {}
  }

  function bioLockNow(autoPrompt) {
    bioSendLockBeacon();
    bioShowLock(!!autoPrompt, '');
  }

  function bioUnlock() {
    if (bioBusy) return;
    if (!bioSupported()) {
      if ($('bioLockMsg')) $('bioLockMsg').textContent = 'Biometria indisponível neste navegador. Use o PIN.';
      if ($('bioPinForm')) $('bioPinForm').className = 'show';
      return;
    }
    bioBusy = true;
    if ($('bioUnlockBtn')) $('bioUnlockBtn').disabled = true;
    if ($('bioLockMsg')) $('bioLockMsg').textContent = '';
    var storedId = bioStore('hud.bio.id') || '';
    fetch('/auth/webauthn/login/options', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(storedId ? { id: storedId } : {})
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || 'Falha ao iniciar biometria'); });
      return r.json();
    }).then(function (opts) {
      opts.challenge = bioB64uToBuf(opts.challenge);
      if (opts.allowCredentials) {
        var list = [];
        for (var i = 0; i < opts.allowCredentials.length; i++) {
          var c = opts.allowCredentials[i];
          list.push({ type: c.type, id: bioB64uToBuf(c.id), transports: c.transports });
        }
        opts.allowCredentials = list;
      }
      return navigator.credentials.get({ publicKey: opts });
    }).then(function (cred) {
      if (!cred) throw new Error('Autenticação cancelada.');
      return fetch('/auth/webauthn/login/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: cred.id,
          response: {
            clientDataJSON: bioBufToB64u(cred.response.clientDataJSON),
            authenticatorData: bioBufToB64u(cred.response.authenticatorData),
            signature: bioBufToB64u(cred.response.signature)
          }
        })
      });
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || 'Falha na verificação'); });
      return r.json();
    }).then(function (res) {
      bioBusy = false;
      if ($('bioUnlockBtn')) $('bioUnlockBtn').disabled = false;
      if (res && typeof res.timeoutMs === 'number') {
        bioTimeoutMs = res.timeoutMs;
        bioStore('hud.bio.timeout', String(bioTimeoutMs));
      }
      token = '';
      connection = { kind: 'loading', message: '' };
      setOffline(false);
      bioHideLock();
      bioPaintControls();
      poll();
    }).catch(function (err) {
      bioBusy = false;
      if ($('bioUnlockBtn')) $('bioUnlockBtn').disabled = false;
      if ($('bioLockMsg')) {
        $('bioLockMsg').textContent = err && err.name === 'NotAllowedError'
          ? 'Toque em "Desbloquear com digital" para confirmar.'
          : ((err && err.message) || 'Não foi possível validar a digital.');
      }
    });
  }

  function bioEnable() {
    if (bioBusy || !bioSupported()) return;
    if (!confirm('Ativar bloqueio por digital neste celular?\n\nO AI HUD vai pedir sua digital ao abrir o app e após 2 min em segundo plano. iPad e Desktop não serão afetados.')) return;
    bioBusy = true;
    var urlOpts = '/auth/webauthn/register/options' + (token ? '?t=' + encodeURIComponent(token) : '');
    var urlVerify = '/auth/webauthn/register/verify' + (token ? '?t=' + encodeURIComponent(token) : '');
    fetch(urlOpts, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || 'Falha ao iniciar cadastro'); });
      return r.json();
    }).then(function (opts) {
      opts.challenge = bioB64uToBuf(opts.challenge);
      opts.user.id = bioB64uToBuf(opts.user.id);
      if (opts.excludeCredentials) {
        var ex = [];
        for (var i = 0; i < opts.excludeCredentials.length; i++) {
          ex.push({ type: opts.excludeCredentials[i].type, id: bioB64uToBuf(opts.excludeCredentials[i].id) });
        }
        opts.excludeCredentials = ex;
      }
      return navigator.credentials.create({ publicKey: opts });
    }).then(function (cred) {
      if (!cred) throw new Error('Cadastro cancelado.');
      return fetch(urlVerify, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: cred.id,
          label: 'Celular',
          response: {
            clientDataJSON: bioBufToB64u(cred.response.clientDataJSON),
            attestationObject: bioBufToB64u(cred.response.attestationObject)
          }
        })
      });
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || 'Falha ao salvar digital'); });
      return r.json();
    }).then(function (res) {
      bioBusy = false;
      bioActive = true;
      bioTimeoutMs = res && typeof res.timeoutMs === 'number' ? res.timeoutMs : 120000;
      if (res && res.id) bioStore('hud.bio.id', res.id);
      bioStore('hud.bio.timeout', String(bioTimeoutMs));
      bioSession('hud.bio.ok', '1');
      token = '';
      try {
        if (history && history.replaceState && /[?&]t=/.test(location.search || '')) {
          history.replaceState(null, '', '/' + (location.hash || ''));
        }
      } catch (e) {}
      bioPaintControls();
      flash('Bloqueio por digital ativado neste celular.');
    }).catch(function (err) {
      bioBusy = false;
      flash('Não ativou a digital: ' + ((err && err.message) || 'cancelado'), false);
    });
  }

  function bioSetTimeout(ms) {
    request('POST', '/auth/webauthn/settings', function (err, res) {
      if (err) return flash('Falhou: ' + err.message, false);
      bioTimeoutMs = res && typeof res.timeoutMs === 'number' ? res.timeoutMs : ms;
      bioStore('hud.bio.timeout', String(bioTimeoutMs));
      bioPaintControls();
      flash('Tempo de bloqueio: ' + bioTimeoutLabel(bioTimeoutMs) + '.');
    }, { timeoutMs: ms });
  }

  function bioDisable() {
    if (!confirm('Desativar o bloqueio por digital neste celular? O app voltará a abrir sem pedir digital.')) return;
    request('POST', '/auth/webauthn/disable', function (err) {
      if (err) return flash('Falhou: ' + err.message, false);
      bioActive = false;
      bioLocked = false;
      bioRemoveStore('hud.bio.id');
      bioRemoveStore('hud.bio.timeout');
      bioSession('hud.bio.ok', null);
      bioPaintControls();
      flash('Bloqueio por digital desativado neste celular.');
    }, { id: bioStore('hud.bio.id') || '' });
  }

  function bioSyncStatus() {
    if (!bioSupported() || (!bioIsMobilePhone() && !bioActive)) return;
    request('GET', '/auth/webauthn/status', function (err, st) {
      if (err || !st) return;
      if (st.enrolled) {
        bioActive = true;
        if (st.credentialId) bioStore('hud.bio.id', st.credentialId);
        if (typeof st.timeoutMs === 'number') {
          bioTimeoutMs = st.timeoutMs;
          bioStore('hud.bio.timeout', String(bioTimeoutMs));
        }
      } else if (bioActive) {
        bioActive = false;
        bioRemoveStore('hud.bio.id');
        bioRemoveStore('hud.bio.timeout');
      }
      bioPaintControls();
    });
  }

  function bioOnUnauthorized() {
    if (!bioActive && !bioSupported()) return false;
    bioActive = true;
    bioShowLock(true, 'Sessão expirada. Confirme sua digital para continuar.');
    return true;
  }

  function bioOnVisibilityChange() {
    if (!bioActive) return false;
    if (document.hidden) {
      bioHiddenAt = new Date().getTime();
      bioSession('hud.bio.hiddenAt', String(bioHiddenAt));
      if (bioTimeoutMs === 0 && !bioLocked) {
        bioLockNow(false);
      }
      return true;
    }
    if (bioLocked) {
      bioShowLock(false, '');
      return true;
    }
    var savedHidden = parseInt(bioSession('hud.bio.hiddenAt') || '0', 10) || bioHiddenAt;
    bioHiddenAt = 0;
    bioSession('hud.bio.hiddenAt', null);
    if (savedHidden > 0 && (new Date().getTime() - savedHidden) >= bioTimeoutMs) {
      bioLockNow(true);
      return true;
    }
    return false;
  }

  function bioInit() {
    if (!bioSupported()) return false;
    var savedId = bioStore('hud.bio.id') || '';
    var savedTimeout = parseInt(bioStore('hud.bio.timeout') || '', 10);
    if (!isNaN(savedTimeout)) bioTimeoutMs = savedTimeout;
    bioActive = !!savedId;
    if (!bioIsMobilePhone() && !bioActive) return false;

    if ($('bioUnlockBtn')) $('bioUnlockBtn').onclick = bioUnlock;
    if ($('bioUsePinBtn')) {
      $('bioUsePinBtn').onclick = function () {
        var f = $('bioPinForm');
        if (!f) return;
        f.className = f.className === 'show' ? '' : 'show';
        if (f.className === 'show') {
          var inp = f.querySelector && f.querySelector('input');
          if (inp && inp.focus) inp.focus();
        }
      };
    }

    bioPaintControls();
    bioConsumeFreshCookie();

    if (bioActive) {
      token = '';
      if (bioSession('hud.bio.ok') !== '1') {
        bioLockNow(true);
        return true; // mantém bloqueado até confirmar digital
      }
      bioSyncStatus();
    } else if (bioIsMobilePhone()) {
      bioSyncStatus();
    }
    return false;
  }
