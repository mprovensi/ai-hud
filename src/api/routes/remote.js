// POST /api/remote: liga/desliga o modo remoto (vale para todos os PCs)
module.exports = ({ permissions, peers, collector, json }) => [
  { method: 'POST', path: '/api/remote', json: true, handler: ({ res, body }) => {
    permissions.setRemote(body.on);
    peers.broadcast('POST', '/api/remote', { on: permissions.remoteMode });
    collector.poke();
    json(res, { remoteMode: permissions.remoteMode });
  } },
];
