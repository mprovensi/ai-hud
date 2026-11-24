// Upgrade WebSocket RFC 6455 em `/ws/pty` com suporte a sessões PTY locais e proxy transparente para peers!
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const { acceptKey, encodeFrame, decodeFrames } = require('../core/websocket');
const { isCwdAllowed } = require('../core/path-guard');
const { recentCwds } = require('../collect/capabilities');
const { resolveWorkspaceRoot } = require('../infra/workspace-paths');
const { readWorkspaceJson } = require('../collect/workspace');
const { authorized } = require('./utils');
const { allowed } = require('./auth');

function rejectUpgrade(socket, status, msg) {
  try {
    socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${msg}`);
  } catch {}
  socket.destroy();
}

function attachWsPty({ server, dataDir, config, webauthn, ptyManager, peers, collector, machineName, log = () => {} }) {
  function isAuthed(req, url) {
    const bioDev = webauthn ? webauthn.deviceFromRequest(req) : { isBioDevice: false };
    return bioDev.isBioDevice
      ? webauthn.validateSession(bioDev.sessionId, bioDev.credId)
      : authorized(req, url, config.token);
  }

  function checkAuthorizedCwd(cwd) {
    const knownCwds = recentCwds(collector.current().sessions, (config && config.pinnedProjects) || []);
    const wsRoots = [];
    if (dataDir) {
      try {
        const ws = readWorkspaceJson(resolveWorkspaceRoot(dataDir, config));
        for (const m of Object.values(ws.groupMeta || {})) if (m && m.rootCwd) wsRoots.push(m.rootCwd);
        for (const e of (ws.entities || [])) {
          for (const b of (e.projectBindings || [])) if (b && b.cwd) wsRoots.push(b.cwd);
        }
      } catch {}
    }
    return isCwdAllowed(cwd, {
      allowedRoots: [...((config && config.allowedRoots) || []), ...wsRoots],
      knownCwds,
      home: os.homedir(),
      strict: true,
    });
  }

  function proxyToPeer(peer, req, socket, head, searchParams) {
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
      const clientKey = req.headers['sec-websocket-key'];
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(clientKey)}\r\n\r\n`,
      );
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head);
      socket.pipe(upSocket);
      upSocket.pipe(socket);
      const cleanup = () => { try { socket.destroy(); } catch {} try { upSocket.destroy(); } catch {} };
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
    const ip = req.socket.remoteAddress;
    if (!allowed(ip)) return rejectUpgrade(socket, 403, 'Forbidden');
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws/pty') return rejectUpgrade(socket, 404, 'Not Found');
    if (!isAuthed(req, url)) return rejectUpgrade(socket, 401, 'Unauthorized');

    const wsKey = req.headers['sec-websocket-key'];
    if (!wsKey) return rejectUpgrade(socket, 400, 'Bad WebSocket Handshake');

    const machine = (url.searchParams.get('machine') || '').trim();
    const isLocal = url.searchParams.get('local') === '1';
    if (!isLocal && machine && machine !== machineName && peers && Array.isArray(peers.list)) {
      const peer = peers.list.find((p) => p.name === machine);
      if (!peer) return rejectUpgrade(socket, 404, 'Machine not found');
      return proxyToPeer(peer, req, socket, head, url.searchParams);
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

    let rx = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    const processChunk = (chunk) => {
      rx = rx.length ? Buffer.concat([rx, chunk]) : Buffer.from(chunk);
      const { frames, rest } = decodeFrames(rx);
      rx = rest;
      for (const f of frames) {
        if (f.opcode === 0x8) {
          try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch {}
          socket.destroy();
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

    const detach = () => {
      offData();
      offExit();
    };
    socket.on('close', detach);
    socket.on('error', detach);
  });
}

module.exports = { attachWsPty };
