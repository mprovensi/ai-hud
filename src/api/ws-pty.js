// Upgrade WebSocket RFC 6455 em `/ws/pty` com suporte a sessões PTY locais e proxy transparente para peers!
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { acceptKey, encodeFrame, decodeFrames } = require('../core/websocket');
const { createCwdAuthorizer } = require('./cwd-auth');
const { authorized } = require('./utils');
const { allowed, isLoopback } = require('./auth');

const MAX_WS_RX_BYTES = 2 * 1024 * 1024;

function rejectUpgrade(socket, status, msg) {
  try {
    socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${msg}`);
  } catch {}
  try { socket.destroy(); } catch {}
}

function normalizeHostPort(hostHeader, proto) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    const u = new URL(`${proto || 'http:'}//${raw}`);
    const defaultPort = u.protocol === 'https:' ? '443' : '80';
    return `${u.hostname}:${u.port || defaultPort}`;
  } catch {
    return '';
  }
}

// Valida cabeçalho Origin contra Host/X-Forwarded-Host (mesmo host e mesma porta).
// Rejeita `Origin: null` e origens de outras portas/domínios (previne CSWSH com cookie).
function isAllowedOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (origin === undefined || origin === '') return true; // clientes nativos / proxy de peers
  const rawOrigin = String(origin).trim();
  if (!rawOrigin || rawOrigin.toLowerCase() === 'null') return false;
  let parsed;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const originDefaultPort = parsed.protocol === 'https:' ? '443' : '80';
  const originHostPort = `${parsed.hostname.toLowerCase()}:${parsed.port || originDefaultPort}`;

  const allowedHosts = new Set();
  const hostHp = normalizeHostPort(req.headers.host, parsed.protocol);
  if (hostHp) allowedHosts.add(hostHp);
  const ip = req.socket && req.socket.remoteAddress;
  if (isLoopback(ip) && req.headers['x-forwarded-host']) {
    const fwdProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' ? 'https:' : parsed.protocol;
    const fwdHp = normalizeHostPort(String(req.headers['x-forwarded-host']).split(',')[0], fwdProto);
    if (fwdHp) allowedHosts.add(fwdHp);
  }
  return allowedHosts.has(originHostPort);
}

function attachWsPty({ server, dataDir, config, webauthn, ptyManager, peers, collector, machineName, log = () => {} }) {
  const checkAuthorizedCwd = createCwdAuthorizer({ dataDir, config, collector });
  const bioSockets = new Set();

  if (webauthn && typeof webauthn.onSessionRevoked === 'function') {
    webauthn.onSessionRevoked(({ sessionId, credId }) => {
      for (const entry of [...bioSockets]) {
        const matchSid = sessionId && entry.sessionId === sessionId;
        const matchCred = !sessionId && credId && entry.credId === credId;
        if (matchSid || matchCred) entry.closeUnauthorized();
      }
    });
  }

  function resolveAuth(req, url) {
    const bioDev = webauthn ? webauthn.deviceFromRequest(req) : { isBioDevice: false, credId: null, sessionId: null };
    if (bioDev.isBioDevice) {
      const ok = webauthn.validateSession(bioDev.sessionId, bioDev.credId);
      return { ok, isBioDevice: true, sessionId: bioDev.sessionId, credId: bioDev.credId };
    }
    return { ok: authorized(req, url, config.token), isBioDevice: false, sessionId: null, credId: null };
  }

  function registerBioSocket(auth, closeFn) {
    if (!auth.isBioDevice) return () => {};
    const entry = { sessionId: auth.sessionId, credId: auth.credId, closeUnauthorized: closeFn };
    bioSockets.add(entry);
    return () => bioSockets.delete(entry);
  }

  function isBioStillValid(auth) {
    if (!auth.isBioDevice) return true;
    return !!(webauthn && webauthn.validateSession(auth.sessionId, auth.credId));
  }

  function proxyToPeer(peer, req, socket, head, searchParams, auth) {
    let target;
    try { target = new URL(peer.url); } catch { return rejectUpgrade(socket, 502, 'Peer URL inválida'); }
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('local', '1');
    nextParams.set('t', peer.token);
    const key = crypto.randomBytes(16).toString('base64');
    const mod = target.protocol === 'https:' ? https : http;
    const upReq = mod.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `/ws/pty?${nextParams.toString()}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });
    upReq.on('upgrade', (upRes, upSocket, upHead) => {
      if (!isBioStillValid(auth)) {
        try { upSocket.destroy(); } catch {}
        return rejectUpgrade(socket, 401, 'Unauthorized');
      }
      const clientKey = req.headers['sec-websocket-key'];
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(clientKey)}\r\n\r\n`,
      );
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head);
      let unregister = () => {};
      const cleanup = () => {
        unregister();
        try { socket.destroy(); } catch {}
        try { upSocket.destroy(); } catch {}
      };
      unregister = registerBioSocket(auth, () => {
        try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch {}
        cleanup();
      });
      socket.on('data', (chunk) => {
        if (!isBioStillValid(auth)) {
          try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch {}
          cleanup();
          return;
        }
        try { upSocket.write(chunk); } catch { cleanup(); }
      });
      upSocket.pipe(socket);
      socket.on('error', cleanup);
      upSocket.on('error', cleanup);
      socket.on('close', cleanup);
      upSocket.on('close', cleanup);
    });
    upReq.on('response', (res) => rejectUpgrade(socket, res.statusCode || 502, 'Peer recusou PTY'));
    upReq.on('error', () => rejectUpgrade(socket, 502, 'Peer offline'));
    upReq.end();
  }

  server.on('upgrade', (req, socket, head) => {
    try {
      const ip = req.socket && req.socket.remoteAddress;
      if (!allowed(ip)) return rejectUpgrade(socket, 403, 'Forbidden');

      const rawUrl = req.url;
      if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
        return rejectUpgrade(socket, 400, 'Bad Request');
      }
      let url;
      try {
        url = new URL(rawUrl, 'http://localhost');
      } catch {
        return rejectUpgrade(socket, 400, 'Bad Request');
      }

      if (url.pathname !== '/ws/pty') return rejectUpgrade(socket, 404, 'Not Found');
      if (!isAllowedOrigin(req)) return rejectUpgrade(socket, 403, 'Forbidden Origin');

      const auth = resolveAuth(req, url);
      if (!auth.ok) return rejectUpgrade(socket, 401, 'Unauthorized');

      const wsKey = req.headers['sec-websocket-key'];
      if (!wsKey) return rejectUpgrade(socket, 400, 'Bad WebSocket Handshake');

      const machine = (url.searchParams.get('machine') || '').trim();
      const isLocal = url.searchParams.get('local') === '1';
      if (!isLocal && machine && machine !== machineName && peers && Array.isArray(peers.list)) {
        const peer = peers.list.find((p) => p.name === machine);
        if (!peer) return rejectUpgrade(socket, 404, 'Machine not found');
        return proxyToPeer(peer, req, socket, head, url.searchParams, auth);
      }

      const cwd = (url.searchParams.get('cwd') || '').trim();
      const mode = (url.searchParams.get('mode') || 'shell').trim();
      const tool = (url.searchParams.get('tool') || '').trim();
      const sessionId = (url.searchParams.get('sessionId') || '').trim();
      const model = (url.searchParams.get('model') || '').trim();
      const cols = Number(url.searchParams.get('cols')) || 100;
      const rows = Number(url.searchParams.get('rows')) || 30;
      const fresh = url.searchParams.get('fresh') === '1';
      const key = (url.searchParams.get('key') || `${mode}:${tool}:${sessionId || cwd}`).slice(0, 180);

      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return rejectUpgrade(socket, 403, check.reason || 'Forbidden cwd');

      let ptySess;
      try {
        ptySess = ptyManager.getOrCreate({ key, cwd, mode, tool, sessionId, model, cols, rows, fresh });
      } catch (err) {
        log(`ws-pty erro: ${err.message}`);
        return rejectUpgrade(socket, 500, err.message || 'PTY error');
      }

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(wsKey)}\r\n\r\n`,
      );

      const sendJson = (obj) => {
        if (socket.destroyed) return;
        try { socket.write(encodeFrame(JSON.stringify(obj), 0x1)); } catch {}
      };

      sendJson({ type: 'ready', cmd: ptySess.cmd, cwd: ptySess.cwd, key: ptySess.key, exited: ptySess.exited });
      const hist = ptySess.history();
      if (hist.length) sendJson({ type: 'out', data: hist.toString('base64') });
      if (ptySess.exited) sendJson({ type: 'exit', code: ptySess.exitCode || 0 });

      const offData = ptySess.onData((raw) => sendJson({ type: 'out', data: raw.toString('base64') }));
      const offExit = ptySess.onExit((code) => sendJson({ type: 'exit', code }));

      let closed = false;
      let unregisterBio = () => {};
      const detach = () => {
        if (closed) return;
        closed = true;
        unregisterBio();
        offData();
        offExit();
      };
      const closeUnauthorized = () => {
        if (closed) return;
        try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch {}
        detach();
        try { socket.destroy(); } catch {}
      };
      unregisterBio = registerBioSocket(auth, closeUnauthorized);

      let rx = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      const processChunk = (chunk) => {
        if (closed) return;
        if (!isBioStillValid(auth)) return closeUnauthorized();
        rx = rx.length ? Buffer.concat([rx, chunk]) : Buffer.from(chunk);
        if (rx.length > MAX_WS_RX_BYTES) {
          try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch {}
          detach();
          try { socket.destroy(); } catch {}
          return;
        }
        const { frames, rest } = decodeFrames(rx);
        rx = rest;
        for (const f of frames) {
          if (!isBioStillValid(auth)) return closeUnauthorized();
          if (f.opcode === 0x8) {
            try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch {}
            detach();
            try { socket.destroy(); } catch {}
            return;
          }
          if (f.opcode === 0x9) {
            try { socket.write(encodeFrame(f.payload, 0xA)); } catch {}
            continue;
          }
          if (f.opcode === 0x1 || f.opcode === 0x2) {
            try {
              const msg = JSON.parse(f.payload.toString('utf8'));
              if (msg.type === 'in' && typeof msg.data === 'string') {
                ptySess.write(msg.data);
              } else if (msg.type === 'resize') {
                ptySess.resize(msg.cols, msg.rows);
              } else if (msg.type === 'kill') {
                ptySess.kill();
              }
            } catch {}
          }
        }
      };

      if (rx.length) processChunk(Buffer.alloc(0));
      socket.on('data', processChunk);
      socket.on('close', detach);
      socket.on('error', detach);
    } catch (err) {
      log(`ws-pty upgrade erro: ${err && err.message ? err.message : err}`);
      rejectUpgrade(socket, 400, 'Bad Request');
    }
  });
}

module.exports = { attachWsPty, isAllowedOrigin };
