// GET /api/snapshot: o painel inteiro (este PC + secundários).
// Com ?desde=<versão>, segura a resposta até algo mudar ou até ?espera=<s> (máx. 25 s): o aparelho
// recebe a mudança na hora sem consultar a cada 10 s. Sem ?desde, responde na hora (versões antigas).
const MAX_WAIT_S = 25;

module.exports = ({ collector, appVersion, json }) => [
  { path: '/api/snapshot', handler: async ({ res, url }) => {
    const since = url.searchParams.get('desde');
    if (since) {
      const wait = Math.min(Number(url.searchParams.get('espera')) || MAX_WAIT_S, MAX_WAIT_S) * 1000;
      await collector.waitChange(since, wait);
    }
    const { snapshot, version } = collector.current();
    json(res, { ...snapshot, now: Date.now(), version, appVersion });
  } },
];
