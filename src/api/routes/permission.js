// POST /api/permission: Permitir/Negar um pedido segurado no modo remoto
module.exports = ({ permissions, peers, collector, relay, json, text, send }) => [
  { method: 'POST', path: '/api/permission', json: true, handler: ({ res, body }) => {
    const { id, decision, session } = body;
    const remote = peers.byId(session);
    if (remote) return relay(res, peers.forward(remote.peer, 'POST', '/api/permission', { id, decision, session: remote.rid }));
    const r = permissions.decide(id, decision);
    if (r === 'gone') return text(res, 410, 'Esse pedido já foi respondido ou expirou.');
    if (r === 'invalid') return send(res, 400, 'text/plain', 'decisão inválida');
    collector.poke();
    json(res, {});
  } },
];
