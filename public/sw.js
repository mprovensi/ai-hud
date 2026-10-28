// Service worker do AI HUD: guarda a casca da página para abrir mesmo sem conexão.
// Os dados (/api/*) vão sempre à rede, para nunca mostrar números velhos como se fossem atuais.
var CACHE = 'ai-hud-v16';
var SHELL = ['/', '/app.css?v=16', '/app.js?v=16', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.indexOf('/api/') === 0) return;
  // Rede primeiro; cache só quando offline. A página é guardada sem a query (?t=) para casar com "/"
  var key = url.pathname === '/' ? '/' : e.request;
  e.respondWith(fetch(e.request).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(key, copy); }); }
    return res;
  }).catch(function () { return caches.match(key); }));
});
