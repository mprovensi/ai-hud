// Service worker do AI HUD: guarda a casca da página para abrir mesmo sem conexão.
// Os dados (/api/*) vão sempre à rede, para nunca mostrar números velhos como se fossem atuais.
// Os marcadores são preenchidos pelo servidor com a mesma versão usada pelo HTML.
var VERSION = '__HUD_VERSION__';
var CACHE = 'ai-hud-' + VERSION;
var SHELL = __HUD_SHELL__;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('ai-hud-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  var key = url.pathname === '/' ? '/' : url.pathname + url.search;
  if (SHELL.indexOf(key) < 0) return; // API, marcas e URLs de outras versões não entram neste cache.
  // HTML pela rede; offline volta à casca desta versão. Nunca mistura HTML novo no cache antigo.
  e.respondWith(fetch(e.request).then(function (res) {
    // Serve pode responder 502 com o PC/HUD parado; uma versão antiga pode receber 409.
    if (res.status >= 500 || (res.status === 409 && key !== '/')) {
      return caches.open(CACHE).then(function (c) { return c.match(key).then(function (saved) { return saved || res; }); });
    }
    if (res.ok && res.headers.get('X-AI-HUD-Version') === VERSION) {
      var copy = res.clone();
      e.waitUntil(caches.open(CACHE).then(function (c) { return c.put(key, copy); }).catch(function () {}));
    }
    return res;
  }).catch(function () { return caches.open(CACHE).then(function (c) { return c.match(key); }); }));
});
