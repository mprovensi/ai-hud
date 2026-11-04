// POST /api/focus: Abrir no PC (actions/focus)
module.exports = ({ focus, peers, collector, relay, json, send }) => [
  { method: 'POST', path: '/api/focus', json: true, handler: async ({ res, body }) => {
    const remote = peers.byId(body.id);
    if (remote) return relay(res, peers.forward(remote.peer, 'POST', '/api/focus', { id: remote.rid }));
    const s = collector.find((x) => x.id === body.id && !x.subagent);
    if (!s) return send(res, 404, 'text/plain', 'sessão não encontrada');
    json(res, await focus(s));
  } },
];
