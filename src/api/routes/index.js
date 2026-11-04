// Rotas autenticadas (token na URL ou cookie). Cada rota: { method?, path, json?, handler }.
// Sem method, aceita qualquer método; com json, o corpo chega já validado em `body`.
// ctx (montado em main.js) traz as peças de collect/, views/, actions/ e federation/.
const routes = [
  require('./snapshot'),
  require('./session'),
  require('./reply'),
  require('./remote'),
  require('./permission'),
  require('./focus'),
  require('./close'),
  require('./refresh'),
  require('./hooks'),
];

function createRoutes(ctx) {
  const json = (res, value, status = 200) => ctx.send(res, status, 'application/json', JSON.stringify(value));
  const text = (res, status, message) => ctx.send(res, status, 'text/plain; charset=utf-8', message);
  // Sessão de outro PC (id "m<n>:..."): repassa a mesma rota ao PC dono e devolve a resposta dele
  const relay = (res, promise) => promise.then(
    (r) => ctx.send(res, r.status, r.status === 200 ? 'application/json' : 'text/plain; charset=utf-8', r.text),
    () => text(res, 502, 'o outro PC não respondeu'));
  const helpers = { ...ctx, json, text, relay };
  return routes.flatMap((make) => make(helpers));
}

module.exports = { createRoutes };
