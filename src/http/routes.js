// Rotas autenticadas (token na URL ou cookie). Cada rota: { method?, path, json?, handler }.
// Sem method, aceita qualquer método; com json, o corpo chega já validado em `body`.
// Sessões de outros PCs (ids "m<n>:") são repassadas ao PC dono pelo hub (peers).
const { execFile } = require('child_process');

function createRoutes({ send, hubSnapshot, appVersion, snapshots, sources, replies, permissions, focus, peers,
  ollamaUrl, codexExe, quotas, machineName, exec = execFile }) {
  const json = (res, value, status = 200) => send(res, status, 'application/json', JSON.stringify(value));
  const text = (res, status, message) => send(res, status, 'text/plain; charset=utf-8', message);
  const fullSnapshot = () => ({ ...hubSnapshot(), appVersion });

  // Devolve ao aparelho a resposta do PC secundário (ou erro se ele não respondeu)
  const relay = (res, promise) => promise.then(
    (r) => send(res, r.status, r.status === 200 ? 'application/json' : 'text/plain; charset=utf-8', r.text),
    () => text(res, 502, 'o outro PC não respondeu'));

  return [
    { path: '/api/snapshot', handler: ({ res }) => json(res, fullSnapshot()) },

    { path: '/api/session', handler: ({ res, url }) => {
      const id = url.searchParams.get('id') || '';
      const remote = peers.byId(id);
      if (remote) {
        return peers.forward(remote.peer, 'GET', `/api/session?id=${encodeURIComponent(remote.rid)}`).then((r) => {
          if (r.status !== 200 || !r.json) return text(res, r.status || 502, r.text || 'sem resposta');
          json(res, { ...r.json, id, machine: remote.peer.name });
        }, () => text(res, 502, `${remote.peer.name} não respondeu`));
      }
      const d = snapshots.detail(id);
      return d ? json(res, { ...d, machine: machineName }) : send(res, 404, 'text/plain', 'sessão não encontrada');
    } },

    // Resposta rápida do HUD. Codex: fila nativa (`codex queue`), que a extensão do VS Code atende sozinha.
    // Claude: fila do HUD, entregue pelo hook-stop.js da sessão (substitui a anterior; "" cancela).
    // Ollama: continua a conversa pelo Ollama local; a resposta fica no HUD (não aparece no app).
    { method: 'POST', path: '/api/reply', json: true, handler: ({ res, body }) => {
      let { key, text: msg, tool, id } = body;
      const remote = peers.byId(id);
      if (remote) return relay(res, peers.forward(remote.peer, 'POST', '/api/reply', { key, text: msg, tool, id: remote.rid }));
      if (!key || typeof key !== 'string') return send(res, 400, 'text/plain', 'sessão inválida');
      msg = String(msg || '').trim().slice(0, 4000);
      if (tool === 'Ollama') {
        const s = sources.all().find((x) => x.tool === 'Ollama' && x.id === key);
        if (!s || !msg) return send(res, 400, 'text/plain', 'sessão inválida');
        return sources.ollamaReply(s, msg, ollamaUrl()).then((r) => json(res, r), (e) => text(res, 409, e.message));
      }
      if (tool === 'Codex') {
        if (!/^[0-9a-f-]{36}$/.test(key) || !msg) return send(res, 400, 'text/plain', 'sessão inválida');
        // --message=… : um texto começando com "-" não vira opção
        return new Promise((resolve) => exec(codexExe, ['queue', '--thread', key, `--message=${msg}`], { windowsHide: true, timeout: 60e3 }, (err, out, errOut) => {
          if (err) text(res, 502, String(errOut || err.message).slice(0, 300));
          else json(res, { sent: true });
          resolve();
        }));
      }
      replies.set(key, msg);
      json(res, { queued: msg || null, listening: replies.listenState(key, Date.now()) });
    } },

    { method: 'POST', path: '/api/remote', json: true, handler: ({ res, body }) => {
      permissions.setRemote(body.on);
      peers.broadcast('POST', '/api/remote', { on: permissions.remoteMode }); // o modo remoto vale para todos os PCs
      json(res, { remoteMode: permissions.remoteMode });
    } },

    { method: 'POST', path: '/api/permission', json: true, handler: ({ res, body }) => {
      const { id, decision, session } = body;
      const remote = peers.byId(session);
      if (remote) return relay(res, peers.forward(remote.peer, 'POST', '/api/permission', { id, decision, session: remote.rid }));
      const r = permissions.decide(id, decision);
      if (r === 'gone') return text(res, 410, 'Esse pedido já foi respondido ou expirou.');
      if (r === 'invalid') return send(res, 400, 'text/plain', 'decisão inválida');
      json(res, {});
    } },

    { method: 'POST', path: '/api/focus', json: true, handler: async ({ res, body }) => {
      const remote = peers.byId(body.id);
      if (remote) return relay(res, peers.forward(remote.peer, 'POST', '/api/focus', { id: remote.rid }));
      const s = snapshots.find(body.id);
      if (!s) return send(res, 404, 'text/plain', 'sessão não encontrada');
      json(res, await focus(s));
    } },

    { method: 'POST', path: '/api/refresh', handler: ({ res }) => {
      if (quotas.sinceRefresh(Date.now()) < 30e3) return send(res, 429, 'text/plain', 'aguarde');
      peers.broadcast('POST', '/api/refresh');
      return quotas.refreshAll().then(() => json(res, fullSnapshot()));
    } },

    // hook-permission.js (mesmo PC, mesmo token)
    { method: 'POST', path: '/hook/permission', json: true, handler: ({ res, body }) => {
      const id = permissions.open(body.session, body.tool, body.summary);
      json(res, id ? { hold: true, id } : { hold: false });
    } },
    { method: 'GET', path: '/hook/permission', handler: ({ res, url }) => json(res, permissions.poll(url.searchParams.get('id') || '')) },
    { method: 'POST', path: '/hook/permission-expire', json: true, handler: ({ res, body }) => { permissions.expire(body.id); json(res, {}); } },

    // hook-stop.js (mesmo PC, mesmo token)
    { method: 'POST', path: '/hook/listen', json: true, handler: ({ res, body }) => {
      if (body.session) replies.listen(body.session, body.tool, body.until);
      json(res, {});
    } },
    { method: 'POST', path: '/hook/unlisten', json: true, handler: ({ res, body }) => { replies.unlisten(body.session); json(res, {}); } },
    { path: '/hook/next', handler: ({ res, url }) => {
      const msg = replies.take(url.searchParams.get('session') || '');
      return msg == null ? send(res, 204, 'application/json', '') : json(res, { text: msg });
    } },
  ];
}

module.exports = { createRoutes };
