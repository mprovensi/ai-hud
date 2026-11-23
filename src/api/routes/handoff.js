// POST /api/handoff: gera `# Handoff` de uma sessão longa e inicia nova sessão na mesma IA ou Cross-IA.
module.exports = ({ handoff, peers, collector, machineName, json, text }) => [
  { method: 'POST', path: '/api/handoff', json: true, handler: async ({ res, body }) => {
    const id = String(body.id || '').trim();
    if (!id) return text(res, 400, 'sessão inválida');
    const remote = peers.byId(id);
    if (remote) {
      try {
        const r = await peers.forward(remote.peer, 'POST', '/api/handoff', {
          id: remote.rid,
          targetTool: body.targetTool,
          targetModel: body.targetModel,
          note: body.note,
        });
        if (r.status !== 200 || !r.json) return text(res, r.status || 502, r.text || `${remote.peer.name} não respondeu`);
        collector.poke();
        const prefixed = r.json.id ? `m${remote.peer.i}:${r.json.id}` : null;
        return json(res, { ...r.json, id: prefixed, machine: remote.peer.name });
      } catch {
        return text(res, 502, `${remote.peer.name} não respondeu`);
      }
    }
    const s = collector.find((x) => x.id === id && !x.subagent);
    if (!s) return text(res, 404, 'sessão não encontrada');
    const r = await handoff({
      session: s,
      targetTool: body.targetTool,
      targetModel: body.targetModel,
      note: body.note,
    });
    if (r.status === 200) collector.poke();
    return typeof r.body === 'string'
      ? text(res, r.status, r.body)
      : json(res, { ...r.body, machine: machineName }, r.status);
  } },
];
