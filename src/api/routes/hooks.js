// Rotas dos hooks do Claude Code (integrations/claude), no mesmo PC e com o mesmo token.
// Cada mudança avisa o coletor: o cartão da sessão muda na hora nos aparelhos.
module.exports = ({ permissions, queue, collector, json, send }) => [
  // hook-permission.js: segura o pedido no modo remoto e consulta a decisão
  { method: 'POST', path: '/hook/permission', json: true, handler: ({ res, body }) => {
    const id = permissions.open(body.session, body.tool, body.summary);
    if (id) collector.poke();
    json(res, id ? { hold: true, id } : { hold: false });
  } },
  { method: 'GET', path: '/hook/permission', handler: ({ res, url }) => {
    const r = permissions.poll(url.searchParams.get('id') || '');
    if (r.gone || r.decision) collector.poke();
    json(res, r);
  } },
  { method: 'POST', path: '/hook/permission-expire', json: true, handler: ({ res, body }) => {
    permissions.expire(body.id);
    collector.poke();
    json(res, {});
  } },

  // hook-stop.js: sessão parada esperando resposta, e entrega da resposta enfileirada
  { method: 'POST', path: '/hook/listen', json: true, handler: ({ res, body }) => {
    if (body.session) { queue.listen(body.session, body.tool, body.until); collector.poke(); }
    json(res, {});
  } },
  { method: 'POST', path: '/hook/unlisten', json: true, handler: ({ res, body }) => {
    queue.unlisten(body.session);
    collector.poke();
    json(res, {});
  } },
  { path: '/hook/next', handler: ({ res, url }) => {
    const msg = queue.take(url.searchParams.get('session') || '');
    if (msg == null) return send(res, 204, 'application/json', '');
    collector.poke();
    return json(res, { text: msg });
  } },
];
