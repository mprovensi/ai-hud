// POST /api/close (encerra/arquiva a sessão) e POST /api/stop (interrompe só o turno atual sem fechar a sessão)
module.exports = ({ close, peers, collector, relay, json, send }) => [
  { method: 'POST', path: '/api/close', json: true, handler: async ({ res, body }) => {
    const remote = peers.byId(body.id);
    if (remote) return relay(res, peers.forward(remote.peer, 'POST', '/api/close', { id: remote.rid }));
    const s = collector.find((x) => x.id === body.id && !x.subagent);
    if (!s) return send(res, 404, 'text/plain', 'sessão não encontrada');
    const r = await close(s);
    if (r.ok) collector.poke();
    json(res, r);
  } },
  { method: 'POST', path: '/api/stop', json: true, handler: async ({ res, body }) => {
    const remote = peers.byId(body.id);
    if (remote) return relay(res, peers.forward(remote.peer, 'POST', '/api/stop', { id: remote.rid }));
    const s = collector.find((x) => x.id === body.id && !x.subagent);
    if (!s) return send(res, 404, 'text/plain', 'sessão não encontrada');
    const r = close.stop ? await close.stop(s) : { ok: false, message: 'Não suportado.' };
    if (r.ok) collector.poke();
    json(res, r);
  } },
];
