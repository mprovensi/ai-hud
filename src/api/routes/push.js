// Rotas de Web Push nativo (VAPID): /api/push/*
module.exports = ({ push, json, text }) => [
  { method: 'GET', path: '/api/push/public-key', handler: ({ res }) => {
    json(res, push.publicInfo());
  } },

  { method: 'POST', path: '/api/push/subscribe', json: true, maxBytes: 8192, handler: ({ res, body }) => {
    const r = push.subscribe(body);
    return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
  } },

  { method: 'POST', path: '/api/push/unsubscribe', json: true, maxBytes: 4096, handler: ({ res, body }) => {
    const r = push.unsubscribe(body.endpoint);
    return json(res, r.body, r.status);
  } },

  { method: 'POST', path: '/api/push/test', json: true, maxBytes: 2048, handler: async ({ res, body }) => {
    const r = await push.notifyAll({
      title: (body && body.title) || 'AI HUD · Teste de notificação',
      body: (body && body.body) || 'Notificações Web Push ativas neste aparelho.',
      tag: 'ai-hud-test',
      url: '/',
    });
    json(res, { ok: true, ...r });
  } },
];
