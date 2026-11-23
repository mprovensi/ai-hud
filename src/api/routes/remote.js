// POST /api/remote: liga/desliga o modo remoto (vale para todos os PCs; ?local=1 evita eco em multi-hub)
module.exports = ({ permissions, peers, collector, json }) => [
  { method: 'POST', path: '/api/remote', json: true, handler: ({ res, url, body }) => {
    permissions.setRemote(body.on);
    if (url.searchParams.get('local') !== '1') peers.broadcast('POST', '/api/remote?local=1', { on: permissions.remoteMode });
    collector.poke();
    json(res, { remoteMode: permissions.remoteMode });
  } },
];
