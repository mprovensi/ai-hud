// POST /api/upload: envia imagem anexada pelo celular/iPad/Workspace para inbox/attachments/
// na máquina dona da sessão (repassa ao peer se id for `m<n>:...`).
module.exports = ({ uploadAttachment, peers, relay, json, text }) => [
  { method: 'POST', path: '/api/upload', json: true, maxBytes: 22 * 1024 * 1024, handler: ({ res, body }) => {
    const remote = body.id ? peers.byId(body.id) : null;
    if (remote) {
      return relay(res, peers.forward(remote.peer, 'POST', '/api/upload', {
        id: remote.rid,
        fileName: body.fileName,
        base64Data: body.base64Data,
      }));
    }
    const r = uploadAttachment({ fileName: body.fileName, base64Data: body.base64Data });
    return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
  } },
];
