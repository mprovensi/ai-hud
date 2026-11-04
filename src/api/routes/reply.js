// POST /api/reply: resposta rápida do HUD para a sessão (actions/reply)
module.exports = ({ reply, peers, collector, relay, json, text }) => [
  { method: 'POST', path: '/api/reply', json: true, handler: async ({ res, body }) => {
    const { key, text: msg, tool, id } = body;
    const remote = peers.byId(id);
    if (remote) return relay(res, peers.forward(remote.peer, 'POST', '/api/reply', { key, text: msg, tool, id: remote.rid }));
    const r = await reply({ key, text: msg, tool });
    if (r.status === 200) collector.poke();
    return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
  } },
];
