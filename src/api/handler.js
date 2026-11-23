// Atendimento de cada requisição: rede permitida → arquivos públicos → login por PIN → token → rotas.
const fs = require('fs');
const path = require('path');
const { authorized, readJson, handleRequest } = require('./utils');
const { allowed, createLoginGuard, loginPage } = require('./auth');

function createHandler({ config, send, serveStatic, webAssets, workspaceDistDir = '', routes, log = console.log }) {
  const guard = createLoginGuard();
  const html = (res, status, body, headers) => send(res, status, 'text/html; charset=utf-8', body, headers);

  function login(req, res, ip) {
    let body = '';
    req.on('data', (c) => { if (body.length < 200) body += c; });
    req.on('end', () => {
      if (guard.blocked(ip)) return html(res, 429, loginPage('Muitas tentativas. Aguarde 5 minutos.'));
      if (new URLSearchParams(body).get('pin') !== config.pin) {
        guard.failed(ip);
        return html(res, 401, loginPage('PIN incorreto.'));
      }
      guard.passed(ip);
      // O token vai na URL para sobreviver ao "Adicionar à Tela de Início" (cookies separados no iOS)
      send(res, 303, 'text/plain', '', { Location: `/?t=${config.token}` });
    });
  }

  return handleRequest(async (req, res) => {
    const ip = req.socket.remoteAddress;
    if (!allowed(ip)) return send(res, 403, 'text/plain', 'proibido');
    const url = new URL(req.url, 'http://x');
    // Registro de acessos vindos de outros aparelhos (diagnóstico); só o caminho, nunca o token da query
    if (!/^(::1|127\.|::ffff:127\.)/.test(ip) && !url.pathname.startsWith('/hook/')) {
      log(`${new Date().toLocaleTimeString('pt-BR')} ${String(ip).replace(/^::ffff:/, '')} ${req.method} ${url.pathname}`);
    }
    if (serveStatic(res, url)) return;
    if (url.pathname === '/login' && req.method === 'POST') return login(req, res, ip);
    if (!authorized(req, url, config.token)) {
      if (url.pathname === '/' || url.pathname === '/workspace' || url.pathname.startsWith('/workspace/')) {
        return html(res, 200, loginPage(''));
      }
      return send(res, 401, 'text/plain; charset=utf-8', 'acesso negado');
    }
    const cookie = { 'Set-Cookie': `hud=${config.token}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax` };
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
