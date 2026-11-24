// POST /api/remote (permissões remotas, padrão ligado) e POST /api/ide-listen (escuta síncrona da IDE Antigravity).
// Ambos valem para todos os PCs; ?local=1 evita eco em multi-hub.
module.exports = ({ permissions, getIdeListen, setIdeListen, peers, collector, json }) => [
  { method: 'POST', path: '/api/remote', json: true, handler: ({ res, url, body }) => {
    permissions.setRemote(body.on);
    if (url.searchParams.get('local') !== '1') peers.broadcast('POST', '/api/remote?local=1', { on: permissions.remoteMode });
    collector.poke();
    json(res, { remoteMode: permissions.remoteMode });
  } },
  { method: 'POST', path: '/api/ide-listen', json: true, handler: ({ res, url, body }) => {
    const on = setIdeListen ? setIdeListen(body.on) : false;
    if (url.searchParams.get('local') !== '1') peers.broadcast('POST', '/api/ide-listen?local=1', { on });
    collector.poke();
    json(res, { ideListen: getIdeListen ? getIdeListen() : on });
  } },
];
