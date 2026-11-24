// GET /api/capabilities: máquinas disponíveis para iniciar uma nova sessão, com suas IAs, modelos e pastas recentes.
// Com ?local=1, devolve apenas as capacidades desta máquina (usado pelo hub para agregar peers sem loop).
module.exports = ({ capabilities, collector, peers, machineName, json }) => [
  { path: '/api/capabilities', handler: async ({ res, url }) => {
    const local = capabilities.get(collector.current().sessions, machineName);
    if (url.searchParams.get('local') === '1') return json(res, { machine: local });
    const remotes = await Promise.all(peers.list.map((p) =>
      peers.forward(p, 'GET', '/api/capabilities?local=1').then((r) => {
        if (r.status === 200 && r.json && r.json.machine) return { ...r.json.machine, name: p.name, online: true };
        return { name: p.name, online: false, tools: {}, cwds: [] };
      }, () => ({ name: p.name, online: false, tools: {}, cwds: [] }))));
    json(res, { machines: [{ ...local, local: true }, ...remotes] });
  } },
];
