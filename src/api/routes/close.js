// POST /api/close: Encerrar a sessão (actions/close)
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
];
