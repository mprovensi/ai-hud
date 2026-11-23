// POST /api/new: inicia uma nova sessão de IA nesta máquina ou repassa à máquina escolhida (peer)
module.exports = ({ launch, peers, collector, machineName, json, text }) => [
  { method: 'POST', path: '/api/new', json: true, handler: async ({ res, url, body }) => {
    const target = String(body.machine || '').trim();
    if (url.searchParams.get('local') !== '1' && target && target !== machineName) {
      const peer = peers.list.find((p) => p.name === target);
      if (!peer) return text(res, 404, `máquina "${target}" não encontrada`);
      try {
        const r = await peers.forward(peer, 'POST', '/api/new?local=1', {
          tool: body.tool, model: body.model, cwd: body.cwd, prompt: body.prompt,
        });
        if (r.status !== 200 || !r.json) return text(res, r.status || 502, r.text || `${peer.name} não respondeu`);
        collector.poke();
        const prefixed = r.json.id ? `m${peer.i}:${r.json.id}` : null;
        return json(res, { ...r.json, id: prefixed, machine: peer.name });
      } catch {
        return text(res, 502, `${peer.name} não respondeu`);
      }
    }
    const r = await launch({ tool: body.tool, model: body.model, cwd: body.cwd, prompt: body.prompt });
    if (r.status === 200) collector.poke();
    return typeof r.body === 'string'
      ? text(res, r.status, r.body)
      : json(res, { ...r.body, machine: machineName }, r.status);
  } },
];
