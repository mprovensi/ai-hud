// POST /api/projects/pin: fixa ou desfixa uma pasta favorita de projeto nesta máquina ou em um peer.
module.exports = ({ setProjectPin, peers, machineName, json, text }) => [
  { method: 'POST', path: '/api/projects/pin', json: true, handler: async ({ res, url, body }) => {
    const target = String(body.machine || '').trim();
    if (url.searchParams.get('local') !== '1' && target && target !== machineName) {
      const peer = peers.list.find((p) => p.name === target);
      if (!peer) return text(res, 404, `máquina "${target}" não encontrada`);
      try {
        const r = await peers.forward(peer, 'POST', '/api/projects/pin?local=1', {
          cwd: body.cwd, pinned: body.pinned,
        });
        if (r.status !== 200 || !r.json) return text(res, r.status || 502, r.text || `${peer.name} não respondeu`);
        return json(res, r.json);
      } catch {
        return text(res, 502, `${peer.name} não respondeu`);
      }
    }
    const r = setProjectPin({ cwd: body.cwd, pinned: body.pinned });
    return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
  } },
];
