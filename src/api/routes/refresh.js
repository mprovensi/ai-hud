// POST /api/refresh: relê as cotas agora (botão ↻), aqui e nos secundários
module.exports = ({ quotas, peers, collector, appVersion, json, send }) => [
  { method: 'POST', path: '/api/refresh', handler: async ({ res }) => {
    if (quotas.sinceRefresh(Date.now()) < 30e3) return send(res, 429, 'text/plain', 'aguarde');
    peers.broadcast('POST', '/api/refresh');
    await quotas.refreshAll();
    collector.poke();
    const { snapshot, version } = collector.current();
    json(res, { ...snapshot, now: Date.now(), version, appVersion });
  } },
];
