  // Pedaços do app.js: o servidor junta os arquivos de web/js/ na ordem de src/infra/web-bundle.js, dentro
  // de uma única função (as variáveis de um pedaço valem nos outros). ES5: roda no Safari 9 do iPad mini 1.

  var APP_VERSION = '__HUD_VERSION__';
  var TOOLS = ['Claude Code', 'Codex', 'Antigravity', 'Ollama'];
  var COLORS = ['#e08a66', '#5fb8a4', '#7d9bf0', '#b39ddb'];
  var token = (/[?&]t=([a-f0-9]+)/.exec(location.search) || [])[1] || '';
  var lastOk = 0, snap = null, view = null;

  function $(id) { return document.getElementById(id); }
  // Ícones de traço (estilo Lucide) em SVG inline: herdam a cor do botão e funcionam no Safari 9
  var ICONS = {
    stats: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    recent: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    remote: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    bellOff: '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M2 2l20 20"/>',
    text: '<path d="M21 14h-5"/><path d="M16 16v-3.5a2.5 2.5 0 0 1 5 0V16"/><path d="M4.5 13h6"/><path d="M3 16l4.5-9 4.5 9"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'
  };
  function icon(name) { return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  // Horários pelo relógio e pelo fuso do PC, não do aparelho (tablet com hora ou fuso errado):
  // skew = hora do PC − hora do aparelho; tzMs = fuso do PC. Ambos chegam em cada snapshot.
  var skew = 0, tzMs = null;
  function serverNow() { return new Date().getTime() + skew; }
  function wall(t) {
    if (tzMs == null) { var d = new Date(t); return { h: d.getHours(), mi: d.getMinutes(), day: d.getDate(), mon: d.getMonth(), wd: d.getDay(), key: d.toDateString() }; }
    var u = new Date(t + tzMs);
    return { h: u.getUTCHours(), mi: u.getUTCMinutes(), day: u.getUTCDate(), mon: u.getUTCMonth(), wd: u.getUTCDay(),
      key: u.getUTCFullYear() + '-' + u.getUTCMonth() + '-' + u.getUTCDate() };
  }
  var WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  function hm(t) { var w = wall(t); return pad(w.h) + ':' + pad(w.mi); }
  function when(t) {
    var w = wall(t), now = serverNow();
    if (w.key === wall(now).key) return 'às ' + hm(t);
    return (w.key === wall(now - 864e5).key ? 'ontem ' : pad(w.day) + '/' + pad(w.mon + 1) + ' ') + hm(t);
  }
  function k(n) { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : '' + n; }
  function dur(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return m + 'min';
    var h = Math.floor(m / 60);
    return h < 24 ? h + 'h' + pad(m % 60) : Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }
  function levelColor(p) { return p >= 80 ? '#e87070' : p >= 50 ? '#e0b45a' : '#5fb8a4'; }
  // Preferências do aparelho; localStorage pode falhar (aba privada no iOS)
  function store(key, val) { try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) {} }
  // Só classes e ES5: funciona também no Safari 9, sem service worker ou APIs modernas.
  function setReading(size) {
    if (size !== 'large' && size !== 'larger') size = 'normal';
    document.body.className = document.body.className.replace(/\bread-(large|larger)\b/g, '').replace(/^\s+|\s+$/g, '') + (size === 'normal' ? '' : ' read-' + size);
    store('hud.reading', size);
    $('textNormal').setAttribute('aria-pressed', size === 'normal' ? 'true' : 'false');
    $('textLarge').setAttribute('aria-pressed', size === 'large' ? 'true' : 'false');
    $('textLarger').setAttribute('aria-pressed', size === 'larger' ? 'true' : 'false');
  }
  setReading(store('hud.reading'));
  $('reading').onclick = function () {
    var open = $('readingOptions').style.display === 'none';
    $('readingOptions').style.display = open ? 'block' : 'none';
    $('reading').setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  $('textNormal').onclick = function () { setReading('normal'); };
  $('textLarge').onclick = function () { setReading('large'); };
  $('textLarger').onclick = function () { setReading('larger'); };
  function toolIndex(t) { for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i] === t) return i; return 0; }

