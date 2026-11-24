// GET /api/session?id=: detalhe de uma sessão (deste PC ou repassado ao PC dono)
module.exports = ({ collector, peers, detail, sessionMeta, running, machineName, json, text, send }) => {
  const withMeta = (id, obj) => {
    const m = sessionMeta && sessionMeta.get(id);
    return m ? { ...obj, pinned: !!m.pinned, alias: m.alias || '', group: m.group || '' } : obj;
  };
  return [
    { path: '/api/session', handler: ({ res, url }) => {
      const id = url.searchParams.get('id') || '';
      const remote = peers.byId(id);
      if (remote) {
        return peers.forward(remote.peer, 'GET', `/api/session?id=${encodeURIComponent(remote.rid)}`).then((r) => {
          if (r.status !== 200 || !r.json) return text(res, r.status || 502, r.text || 'sem resposta');
          const canonicalId = r.json.id ? `m${remote.peer.i}:${r.json.id}` : id;
          json(res, withMeta(canonicalId, { ...r.json, id: canonicalId, machine: remote.peer.name }));
        }, () => text(res, 502, `${remote.peer.name} não respondeu`));
      }
      const s = collector.find((x) => !x.subagent && (x.id === id || x.id.endsWith('-' + id)));
      if (s) return json(res, withMeta(s.id, { ...detail(s, Date.now()), machine: machineName }));
      const err = running && running.lastError(id);
      if (err) return send(res, 502, 'text/plain; charset=utf-8', err);
      return send(res, 404, 'text/plain', 'sessão não encontrada');
    } },
  ];
};
