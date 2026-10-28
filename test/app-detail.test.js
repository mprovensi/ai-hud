const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Isola a função real da UI para simular consultas sem navegador ou dependências.
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = app.indexOf('  function loadDetail()');
const end = app.indexOf('\n  // A tela sobreposta', start);
assert.ok(start >= 0 && end > start);
const source = app.slice(start, end) + '\nthis.loadDetail = loadDetail;';

test('detail deferred while typing renders after typing stops, even with unchanged data', () => {
  let typing = true;
  const draws = [];
  const old = { id: 's1', now: 1, lastReply: 'anterior' };
  const updated = { id: 's1', now: 2, lastReply: 'nova' };
  const context = { location: { hash: '#s=s1' }, detailCache: { s1: old },
    request: (method, url, done) => done(null, updated), typing: () => typing,
    renderDetail: (detail) => draws.push(detail), $: () => null };
  vm.runInNewContext(source, context);
  context.loadDetail();
  assert.equal(draws.length, 0);
  typing = false;
  context.loadDetail();
  assert.equal(draws.length, 1);
  assert.equal(draws[0], updated);
  updated.now = 3;
  context.loadDetail();
  assert.equal(draws.length, 1, 'clock-only changes should not redraw');
});

test('detail preserves scroll position during updates', () => {
  for (const top of [20, 80]) {
    const previous = { scrollTop: top, clientHeight: 20, scrollHeight: 100 };
    const next = { className: 'quote lastreply', scrollHeight: 150, scrollTop: 0 };
    let box = previous;
    const context = { location: { hash: '#s=s1' }, detailCache: {},
      request: (method, url, done) => done(null, { id: 's1', now: 1 }), typing: () => false,
      renderDetail: () => { box = next; }, $: () => box };
    vm.runInNewContext(source, context);
    context.loadDetail();
    assert.equal(next.scrollTop, top);
  }
});

test('dashboard preserves server session priority', () => {
  const renderStart = app.indexOf('  function render(s)');
  const renderEnd = app.indexOf('\n  // ---- Sobreposições', renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const nodes = {};
  const context = { GRID_MIN: 6, view: null, setRemoteBtn: () => {}, quotaPanel: () => {}, ollamaPanel: () => {},
    sessCard: (s) => s.id + ';', $: (id) => nodes[id] || (nodes[id] = {}), esc: (s) => s, isSeen: () => false };
  vm.runInNewContext(app.slice(renderStart, renderEnd) + '\nthis.render = render;', context);
  context.render({ active: [{ id: 'permission', state: 'permission', end: 1 }, { id: 'working', state: 'working', end: 2 }],
    recent: [], today: { 'Claude Code': { fresh: 0 }, Codex: { fresh: 0 } }, quotas: {} });
  assert.equal(nodes.sessList.innerHTML, 'permission;working;');
});
