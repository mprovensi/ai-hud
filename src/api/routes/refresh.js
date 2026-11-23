// POST /api/refresh: relê as cotas agora (botão ↻), aqui e nos secundários (?local=1 evita eco em multi-hub)
module.exports = ({ quotas, peers, collector, appVersion, json, send }) => [
  { method: 'POST', path: '/api/refresh', handler: async ({ res, url }) => {
    if (quotas.sinceRefresh(Date.now()) < 30e3) return send(res, 429, 'text/plain', 'aguarde');
    if (url.searchParams.get('local') !== '1') peers.broadcast('POST', '/api/refresh?local=1');
    await quotas.refreshAll();
    collector.poke();
    const { snapshot, version } = collector.current();
    json(res, { ...snapshot, now: Date.now(), version, appVersion });
  } },
];
