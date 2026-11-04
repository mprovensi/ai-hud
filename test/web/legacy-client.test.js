const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('the complete client boots and receives data without service workers, Promise or fetch', () => {
  const directory = path.join(__dirname, '../../web');
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  const nodes = {}, requests = [];
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    nodes[match[1]] = { id: match[1], style: {}, className: '', innerHTML: '', textContent: '',
      setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k]; } };
  }
  class XHR {
    constructor() { requests.push(this); }
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const context = { document: { body: { className: '' }, documentElement: {}, hidden: false,
      getElementById: (id) => nodes[id] || null, addEventListener: () => {} },
    navigator: {}, location: { search: '', hash: '' }, history: {}, XMLHttpRequest: XHR,
    Promise: undefined, fetch: undefined, localStorage: { getItem() { throw new Error('storage unavailable'); }, setItem() { throw new Error('storage unavailable'); } },
    addEventListener: () => {}, setInterval: () => {}, setTimeout: () => {}, innerWidth: 1024 };
  context.window = context;
  vm.runInNewContext(require('../helpers/app-source'), context);
  assert.equal(requests.length, 1);
  assert.match(nodes.status.innerHTML, /conectando/);
  Object.assign(requests[0], { readyState: 4, status: 200, responseText: JSON.stringify({
    now: Date.now(), active: [], recent: [], quotas: {}, today: { 'Claude Code': { fresh: 0 }, Codex: { fresh: 0 } },
  }) });
  requests[0].onreadystatechange();
  assert.match(nodes.status.innerHTML, /ao vivo/);
  assert.match(nodes.sessList.innerHTML, /Nenhuma sessão/);
  nodes.textLarger.onclick();
  assert.match(context.document.body.className, /read-larger/);
});
