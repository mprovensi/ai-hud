// Atendimento de cada requisição: rede permitida → arquivos públicos → login por PIN/digital → token/sessão → rotas.
const fs = require('fs');
const path = require('path');
const { authorized, readJson, handleRequest } = require('./utils');
const { allowed, createLoginGuard, loginPage } = require('./auth');
const { bioLoginPage } = require('./webauthn');

function createHandler({ config, send, serveStatic, webAssets, workspaceDistDir = '', routes, webauthn = null, log = console.log }) {
  const guard = createLoginGuard();
  const html = (res, status, body, headers) => send(res, status, 'text/html; charset=utf-8', body, headers);
  const json = (res, status, value, headers) => send(res, status, 'application/json', JSON.stringify(value), headers);

  function login(req, res, ip) {
    let body = '';
    req.on('data', (c) => { if (body.length < 200) body += c; });
    req.on('end', () => {
      const bioDev = webauthn ? webauthn.deviceFromRequest(req) : { isBioDevice: false };
      const page = bioDev.isBioDevice ? bioLoginPage : loginPage;
      if (guard.blocked(ip)) return html(res, 429, page('Muitas tentativas. Aguarde 5 minutos.'));
      if (new URLSearchParams(body).get('pin') !== config.pin) {
        guard.failed(ip);
        return html(res, 401, page('PIN incorreto.'));
      }
      guard.passed(ip);
      if (bioDev.isBioDevice) {
        const sid = webauthn.createSession(bioDev.credId);
        const { isHttps } = webauthn.requestContext(req);
        return send(res, 303, 'text/plain', '', {
          Location: '/',
          'Set-Cookie': webauthn.sessionCookies(sid, bioDev.credId, isHttps),
        });
      }
      // O token vai na URL para sobreviver ao "Adicionar à Tela de Início" (cookies separados no iOS)
      send(res, 303, 'text/plain', '', { Location: `/?t=${config.token}` });
    });
  }

  async function handlePublicWebAuthn(req, res, url, ip) {
    if (!webauthn) return false;
    if (url.pathname === '/auth/webauthn/lock' && req.method === 'POST') {
      const bioDev = webauthn.deviceFromRequest(req);
      webauthn.revokeSession(bioDev.sessionId);
      const { isHttps } = webauthn.requestContext(req);
      json(res, 200, { ok: true }, { 'Set-Cookie': webauthn.lockCookies(isHttps) });
      return true;
    }
    if (url.pathname === '/auth/webauthn/login/options' && req.method === 'POST') {
      if (guard.blocked(ip)) { send(res, 429, 'text/plain; charset=utf-8', 'Muitas tentativas. Aguarde 5 minutos.'); return true; }
      const body = await readJson(req, 4096).catch(() => ({}));
      try { json(res, 200, webauthn.loginOptions(req, body)); }
      catch (err) { send(res, 400, 'text/plain; charset=utf-8', err.message || 'biometria indisponível'); }
      return true;
    }
    if (url.pathname === '/auth/webauthn/login/verify' && req.method === 'POST') {
      if (guard.blocked(ip)) { send(res, 429, 'text/plain; charset=utf-8', 'Muitas tentativas. Aguarde 5 minutos.'); return true; }
      const body = await readJson(req, 16384);
      try {
        const result = webauthn.verifyAuthentication(req, body);
        guard.passed(ip);
        json(res, 200, { ok: true, id: result.credId, timeoutMs: result.timeoutMs }, {
          'Set-Cookie': webauthn.sessionCookies(result.sessionId, result.credId, result.isHttps),
        });
      } catch (err) {
        guard.failed(ip);
        send(res, 401, 'text/plain; charset=utf-8', err.message || 'falha na biometria');
      }
      return true;
    }
    return false;
  }

  async function handleAuthedWebAuthn(req, res, url) {
    if (!webauthn) return false;
    if (url.pathname === '/auth/webauthn/status' && req.method === 'GET') {
      json(res, 200, webauthn.statusFor(req));
      return true;
    }
    if (url.pathname === '/auth/webauthn/register/options' && req.method === 'POST') {
      json(res, 200, webauthn.registerOptions(req));
      return true;
    }
    if (url.pathname === '/auth/webauthn/register/verify' && req.method === 'POST') {
      const body = await readJson(req, 32768);
      try {
        const result = webauthn.verifyRegistration(req, body);
        json(res, 200, { ok: true, id: result.credId, timeoutMs: result.timeoutMs }, {
          'Set-Cookie': webauthn.sessionCookies(result.sessionId, result.credId, result.isHttps),
        });
      } catch (err) {
        send(res, 400, 'text/plain; charset=utf-8', err.message || 'falha ao cadastrar digital');
      }
      return true;
    }
    if (url.pathname === '/auth/webauthn/settings' && req.method === 'POST') {
      const body = await readJson(req, 4096);
      try { json(res, 200, { ok: true, ...webauthn.updateSettings(body) }); }
      catch (err) { send(res, 400, 'text/plain; charset=utf-8', err.message || 'configuração inválida'); }
      return true;
    }
    if (url.pathname === '/auth/webauthn/disable' && req.method === 'POST') {
      const body = await readJson(req, 4096).catch(() => ({}));
      const result = webauthn.disableDevice(req, body);
      json(res, 200, { ok: true, removed: result.removed }, {
        'Set-Cookie': webauthn.disableCookies(config.token, result.isHttps),
      });
      return true;
    }
    return false;
  }

  return handleRequest(async (req, res) => {
    const ip = req.socket.remoteAddress;
    if (!allowed(ip)) return send(res, 403, 'text/plain', 'proibido');
    const url = new URL(req.url, 'http://x');
    // Registro de acessos vindos de outros aparelhos (diagnóstico); só o caminho, nunca o token da query
    if (!/^(::1|127\.|::ffff:127\.)/.test(ip) && !url.pathname.startsWith('/hook/')) {
      log(`${new Date().toLocaleTimeString('pt-BR')} ${String(ip).replace(/^::ffff:/, '')} ${req.method} ${url.pathname}`);
    }
    if (serveStatic(res, url, req)) return;
    if (url.pathname === '/login' && req.method === 'POST') return login(req, res, ip);
    if (await handlePublicWebAuthn(req, res, url, ip)) return;

    const bioDev = webauthn ? webauthn.deviceFromRequest(req) : { isBioDevice: false };
    const isAuthed = bioDev.isBioDevice
      ? webauthn.validateSession(bioDev.sessionId, bioDev.credId)
      : authorized(req, url, config.token);

    if (!isAuthed) {
      if (url.pathname === '/' || url.pathname === '/workspace' || url.pathname.startsWith('/workspace/')) {
        return html(res, 200, bioDev.isBioDevice ? bioLoginPage('') : loginPage(''));
      }
      if (bioDev.isBioDevice) {
        return send(res, 401, 'text/plain; charset=utf-8', 'bloqueado: use sua digital', { 'X-AI-HUD-Auth': 'biometric' });
      }
      return send(res, 401, 'text/plain; charset=utf-8', 'acesso negado');
    }
    if (await handleAuthedWebAuthn(req, res, url)) return;

    const cookie = bioDev.isBioDevice
      ? {}
      : { 'Set-Cookie': `hud=${config.token}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax` };
    if (url.pathname === '/') {
      return html(res, 200, webAssets.html, cookie);
    }
    if (url.pathname === '/workspace' || url.pathname.startsWith('/workspace/')) {
      const idx = workspaceDistDir ? path.join(workspaceDistDir, 'index.html') : '';
      if (idx && fs.existsSync(idx)) {
        return html(res, 200, fs.readFileSync(idx, 'utf8'), cookie);
      }
      return html(res, 503, '<!doctype html><meta charset="utf-8"><body style="background:#121211;color:#ecece8;font:16px sans-serif;padding:40px"><h2>AI Workspace ainda não compilado</h2><p>Rode <code>npm --prefix workspace-app run build</code>.</p><p><a href="/" style="color:#5fb8a4">Voltar ao AI HUD</a></p></body>');
    }
    const route = routes.find((r) => r.path === url.pathname && (!r.method || r.method === req.method));
    if (!route) return send(res, 404, 'text/plain', 'não encontrado');
    const body = route.json ? await readJson(req, route.maxBytes) : null;
    return route.handler({ req, res, url, body });
  });
}

module.exports = { createHandler };
