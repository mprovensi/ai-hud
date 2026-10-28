const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const network = app.slice(app.indexOf('  function request(method'), app.indexOf('\n  setSound(soundOn);'));

function client() {
  const nodes = {}, requests = [];
  const node = (id) => nodes[id] || (nodes[id] = { style: {}, innerHTML: '', textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  class XHR {
    constructor() { requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    send() {}
    answer(status, value) { this.status = status; this.readyState = 4; this.responseText = typeof value === 'string' ? value : JSON.stringify(value); this.onreadystatechange(); }
  }
  const context = { $: node, XMLHttpRequest: XHR, token: '', lastOk: 0, snap: null, view: null, skew: 0, tzMs: null,
    APP_VERSION: 'current', esc: String, hm: () => '09:30', checkAlerts: () => {}, render: () => {}, loadDetail: () => {} };
  vm.runInNewContext(network, context);
  return { c: context, nodes, requests };
}
const snapshot = (overrides = {}) => ({ now: Date.now(), active: [], recent: [], quotas: {}, today: {}, ...overrides });
function failure(message, props = {}) { return Object.assign(new Error(message), props); }

test('authentication errors stay visible through clock ticks and stop automatic polling', () => {
  const { c, nodes, requests } = client();
  c.apply(null, snapshot(), 'same');
  c.apply(failure('sessão expirada', { status: 401 }));
  c.lastAttempt = 0;
  c.tick(); c.tick();
  assert.match(nodes.status.innerHTML, /entrar novamente/);
  assert.equal(nodes.status.attrs['data-state'], 'auth');
  assert.equal(nodes.offline.className, 'show');
  assert.equal(nodes.loginAgain.style.display, 'inline-block');
  assert.equal(requests.length, 0);
  c.apply(null, snapshot(), 'same'); // Igualdade dos dados não deve impedir a recuperação.
  assert.match(nodes.status.innerHTML, /ao vivo/);
  assert.equal(nodes.offline.className, '');
});

test('one network failure never claims live; two failures open reconnect and recovery preserves data', () => {
  const { c, nodes } = client();
  c.apply(null, snapshot(), 'same');
  c.apply(failure('sem conexão', { offline: true }));
  c.tick();
  assert.match(nodes.status.innerHTML, /sem conexão/);
  assert.equal(nodes.offline.className, '');
  assert.match(nodes.connectionInfo.textContent, /Exibindo dados recebidos/);
  c.apply(failure('sem conexão', { offline: true }));
  assert.equal(nodes.offline.className, 'show');
  assert.match(nodes.offlineTitle.textContent, /Sem conexão/);
  assert.equal(nodes.loginAgain.style.display, 'none');
  c.apply(null, snapshot(), 'same');
  assert.equal(nodes.offline.className, '');
  assert.equal(c.connection.kind, 'live');
});

test('server and invalid-response errors persist until a valid snapshot; old data gets a timestamp', () => {
  const { c, nodes } = client();
  c.apply(null, snapshot(), 'same');
  c.apply(failure('erro do servidor (HTTP 500)', { status: 500 }));
  c.tick();
  assert.match(nodes.status.innerHTML, /falha na atualização/);
  assert.match(nodes.connectionInfo.textContent, /HTTP 500/);
  c.apply(null, {});
  c.tick();
  assert.equal(c.connection.kind, 'server');
  assert.match(nodes.connectionInfo.textContent, /resposta inválida/);
});

test('XHR handles timeout once and never mistakes invalid JSON for a valid response', () => {
  const { c, requests } = client();
  const answers = [];
  c.request('GET', '/api/snapshot', (err) => answers.push(err));
  requests[0].ontimeout(); requests[0].onerror(); requests[0].onabort();
  assert.equal(answers.length, 1);
  assert.equal(answers[0].offline, true);
  c.request('GET', '/api/snapshot', (err) => answers.push(err));
  requests[1].answer(200, '<html>not JSON</html>');
  assert.equal(answers.length, 2);
  assert.match(answers[1].message, /resposta inválida/);
  assert.notEqual(answers[1].offline, true);
});

test('a new app version is offered without automatically reloading a draft', () => {
  const { c, nodes } = client();
  c.apply(null, snapshot({ appVersion: 'next' }), 'new');
  assert.equal(nodes.updateNotice.style.display, 'block');
  let reloads = 0;
  c.location = { reload: () => { reloads++; } };
  c.typing = () => true;
  c.confirm = () => false;
  vm.runInNewContext(app.slice(app.indexOf("  $('applyUpdate').onclick"), app.indexOf('\n  // App instalado no Android')), c);
  nodes.applyUpdate.onclick();
  assert.equal(reloads, 0);
  c.confirm = () => true;
  nodes.applyUpdate.onclick();
  assert.equal(reloads, 1);
});

test('reading size persists with ES5 classes and keeps other body classes', () => {
  const { c, nodes } = client();
  const storage = {};
  c.document = { body: { className: 'existing' } };
  c.store = (key, value) => value === undefined ? storage[key] : (storage[key] = value);
  vm.runInNewContext(app.slice(app.indexOf('  function setReading('), app.indexOf('  function toolIndex(')), c);
  nodes.textLarger.onclick();
  assert.equal(storage['hud.reading'], 'larger');
  assert.equal(c.document.body.className.trim(), 'existing read-larger');
  nodes.textNormal.onclick();
  assert.equal(c.document.body.className, 'existing');
  assert.equal(nodes.textNormal.attrs['aria-pressed'], 'true');
});
