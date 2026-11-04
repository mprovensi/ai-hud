// GET /api/session?id=: detalhe de uma sessão (deste PC ou repassado ao PC dono)
module.exports = ({ collector, peers, detail, machineName, json, text, send }) => [
  { path: '/api/session', handler: ({ res, url }) => {
    const id = url.searchParams.get('id') || '';
    const remote = peers.byId(id);
    if (remote) {
      return peers.forward(remote.peer, 'GET', `/api/session?id=${encodeURIComponent(remote.rid)}`).then((r) => {
        if (r.status !== 200 || !r.json) return text(res, r.status || 502, r.text || 'sem resposta');
        json(res, { ...r.json, id, machine: remote.peer.name });
      }, () => text(res, 502, `${remote.peer.name} não respondeu`));
    }
    const s = collector.find((x) => x.id === id && !x.subagent);
    return s ? json(res, { ...detail(s, Date.now()), machine: machineName }) : send(res, 404, 'text/plain', 'sessão não encontrada');
  } },
];
