const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = require('../helpers/app-source');
function section(from, to) {
  const start = app.indexOf(from), end = app.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return app.slice(start, end);
}
const source = section('  var seenReplies =', '\n  // ---- Burn-up') +
  section('  function checkAlerts(s)', '\n  function setRemoteBtn') +
  section('  function render(s)', '\n  // ---- Sobreposições') +
  section('  function syncHash()', '\n  document.addEventListener(\'click\'');

function client(storage = {}) {
  const nodes = {}, alerts = [];
  const context = { view: null, snap: null, prevStates: null, prevCompleted: null,
    pings: {}, quotaAlerted: {}, GRID_MIN: 6, location: { hash: '#s=test' },
    store: (key, value) => value === undefined ? storage[key] : (storage[key] = value),
    $: (id) => nodes[id] || (nodes[id] = {}), esc: (s) => String(s || ''),
    toolIndex: () => 1, toolIcon: () => '', k: (n) => String(n || 0), dur: () => '1min', when: () => 'agora',
    beep: () => {}, flash: (msg) => alerts.push(msg), setRemoteBtn: () => {}, quotaPanel: () => {}, ollamaPanel: () => {},
    quickDetail: () => {}, loadDetail: () => {}, renderRecent: () => {}, renderStats: () => {}, renderOllama: () => {},
    setTimeout: () => {}, history: { back: () => { context.location.hash = ''; context.syncHash(); } } };
  vm.runInNewContext(source, context);
  return { context, nodes, alerts, storage };
}

function session(overrides = {}) {
  return { id: 'test', tool: 'Codex', project: 'Teste', state: 'waiting', completedAt: 1000,
    end: 1000, start: 1, prompts: 1, tokens: 10, ...overrides };
}

function snapshot(active) {
  return { now: 2000, active, recent: [], quotas: {}, today: { 'Claude Code': { fresh: 0 }, Codex: { fresh: 0 } } };
}

test('opening and closing acknowledges the displayed reply and removes the card highlight', () => {
  const c = client(), s = session();
  c.context.pings.test = 1000;
  c.context.rememberViewed(s);
  assert.equal(c.context.isSeen(s), false, 'opening alone is not acknowledgement');
  c.context.closeOverlay();
  assert.equal(c.context.isSeen(s), true);
  assert.ok(c.context.badge(s, 2000).includes('visto'));
  const html = c.context.sessCard(s, 2000);
  assert.ok(!html.includes('waiting-card'));
  assert.ok(!html.includes('sua vez'));
  assert.equal(c.context.pings.test, undefined);
});

test('browser Back and switching to another detail acknowledge the card being closed', () => {
  for (const hash of ['', '#recentes', '#s=other']) {
    const c = client(), s = session();
    c.context.rememberViewed(s);
    c.context.location.hash = hash;
    c.context.syncHash();
    assert.equal(c.context.isSeen(s), true, hash);
  }
});

test('acknowledgement persists across app reloads', () => {
  const storage = {}, c = client(storage), s = session();
  c.context.rememberViewed(s);
  c.context.acknowledgeViewed();
  assert.equal(client(storage).context.isSeen(s), true);
  assert.equal(client({ 'hud.seen': 'invalid JSON' }).context.isSeen(s), false);
});

test('a new reply restores attention and alerts once, even while still waiting', () => {
  const c = client(), old = session(), next = session({ completedAt: 2000 });
  c.context.rememberViewed(old);
  c.context.acknowledgeViewed();
  c.context.checkAlerts(snapshot([old]));
  assert.equal(c.alerts.length, 0);
  assert.equal(c.context.isSeen(next), false);
  c.context.checkAlerts(snapshot([next]));
  c.context.checkAlerts(snapshot([next]));
  assert.equal(c.alerts.length, 1);
  assert.ok(c.context.badge(next, 2000).includes('sua vez'));
});

test('a new reply not displayed before closing remains unread', () => {
  const c = client(), visible = session(), unseen = session({ completedAt: 3000, prompts: 2 });
  c.context.rememberViewed(visible);
  c.context.snap = snapshot([unseen]);
  c.context.closeOverlay();
  assert.equal(c.context.isSeen(visible), true);
  assert.equal(c.context.isSeen(unseen), false);
});

test('permissions and working sessions require their own actions', () => {
  for (const s of [session({ state: 'permission', permission: { id: 'p1' } }),
    session({ permission: { id: 'p1' } }), session({ state: 'working' })]) {
    const c = client();
    c.context.rememberViewed(s);
    c.context.closeOverlay();
    assert.equal(c.context.isSeen(s), false);
    assert.equal(c.storage['hud.seen'], undefined);
  }
});

test('legacy sessions without completion timestamps rearm on new activity', () => {
  const c = client(), old = session({ completedAt: 0 });
  c.context.rememberViewed(old);
  c.context.acknowledgeViewed();
  assert.equal(c.context.isSeen({ ...old, now: 5000 }), true);
  assert.equal(c.context.isSeen({ ...old, end: 2000 }), false);
  assert.equal(c.context.isSeen({ ...old, prompts: 2 }), false);
});

test('read cards keep their position and leave the waiting counter', () => {
  const c = client(), seen = session(), unread = session({ id: 'unread' }), working = session({ id: 'working', state: 'working' });
  c.context.rememberViewed(seen);
  c.context.acknowledgeViewed();
  c.context.render(snapshot([seen, unread, working]));
  const html = c.nodes.sessList.innerHTML;
  assert.ok(html.indexOf('data-id="test"') < html.indexOf('data-id="unread"'));
  assert.ok(html.indexOf('data-id="unread"') < html.indexOf('data-id="working"'));
  assert.ok(c.nodes.sessTitle.innerHTML.includes('1 esperando você'));
});

test('browser and home-screen shortcut show the same order with independent read histories', () => {
  const browser = client(), shortcut = client();
  const codex = session({ id: 'codex', end: 2000, completedAt: 2000 });
  const ollama = session({ id: 'ollama', tool: 'Ollama', end: 1000 });
  browser.context.rememberViewed(codex);
  browser.context.acknowledgeViewed();
  assert.equal(browser.context.isSeen(codex), true);
  assert.equal(shortcut.context.isSeen(codex), false);
  for (const c of [browser, shortcut]) {
    c.context.render(snapshot([codex, ollama]));
    const html = c.nodes.sessList.innerHTML;
    assert.ok(html.indexOf('data-id="codex"') < html.indexOf('data-id="ollama"'));
  }
});
