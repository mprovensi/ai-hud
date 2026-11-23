const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('botão + Nova abre gaveta lateral, lista máquinas/IAs/modelos e inicia sessão via POST /api/new', () => {
  const directory = path.join(__dirname, '../../web');
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  const nodes = {}, requests = [], listeners = {};
  const makeNode = (id) => ({
    id, style: {}, className: '', innerHTML: '', textContent: '', value: '', disabled: false,
    setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k]; },
    getElementsByTagName() { return []; }, focus() {}, blur() {},
  });
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes[match[1]] = makeNode(match[1]);
  const dynamic = {
    back: makeNode('back'),
    newModel: makeNode('newModel'),
    newCwd: makeNode('newCwd'),
    newPrompt: makeNode('newPrompt'),
    startNewSess: makeNode('startNewSess'),
  };
  const byId = (id) => nodes[id] || dynamic[id] || null;
  class XHR {
    constructor() { requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    send(body) { this.sentBody = body; }
    setRequestHeader() {}
  }
  const context = {
    document: { body: { className: '' }, documentElement: {}, hidden: false, getElementById: byId, addEventListener: () => {} },
    navigator: {}, location: { search: '', hash: '' }, history: { back() {} }, XMLHttpRequest: XHR,
    Promise: undefined, fetch: undefined, localStorage: { getItem() { return null; }, setItem() {} },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    setInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {}, innerWidth: 1024,
  };
  context.window = context;
  vm.runInNewContext(require('../helpers/app-source'), context);

  // Clica no botão + Nova no topo
  nodes.openNew.onclick();
  assert.equal(context.location.hash, 'nova');
  context.location.hash = '#nova';
  for (const fn of listeners.hashchange || []) fn();

  const capsReq = requests.find((r) => r.url.startsWith('/api/capabilities'));
  assert.ok(capsReq, 'deve buscar GET /api/capabilities ao abrir #nova');
  Object.assign(capsReq, {
    readyState: 4, status: 200,
    responseText: JSON.stringify({
      machines: [
        { name: 'VPS-Oracle', online: true, home: '/home/ubuntu', cwds: [], tools: {} },
        {
          name: 'MateusNote', online: true, home: 'C:\\Users\\mprov', cwds: ['d:\\Projetos\\ai-hud'],
          tools: {
            'Claude Code': { models: [{ id: '', label: 'Padrão' }, { id: 'sonnet', label: 'Sonnet' }] },
            Gemini: { models: [{ id: '', label: 'Padrão' }, { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' }] },
          },
        },
        { name: 'PC-Desktop', online: false, tools: {}, cwds: [] },
      ],
    }),
  });
  capsReq.onreadystatechange();

  // Seleciona automaticamente a primeira máquina online que tem IAs (MateusNote) e lista as outras com status
  assert.match(nodes.overlayBody.innerHTML, /VPS-Oracle<small> \(sem IAs\)<\/small>/);
  assert.match(nodes.overlayBody.innerHTML, /MateusNote/);
  assert.match(nodes.overlayBody.innerHTML, /PC-Desktop<small> \(offline\)<\/small>/);
  assert.match(nodes.overlayBody.innerHTML, /Todas as permissões ativadas/);
  assert.match(nodes.overlayBody.innerHTML, /d:\\Projetos\\ai-hud/);

  // Envia nova sessão via POST /api/new
  dynamic.newPrompt.value = 'Crie um resumo do projeto';
  dynamic.startNewSess.onclick();
  const newReq = requests.find((r) => r.method === 'POST' && r.url.startsWith('/api/new'));
  assert.ok(newReq, 'deve enviar POST /api/new');
  const payload = JSON.parse(newReq.sentBody);
  assert.equal(payload.machine, 'MateusNote');
  assert.equal(payload.tool, 'Claude Code');
  assert.equal(payload.cwd, 'd:\\Projetos\\ai-hud');
  assert.equal(payload.prompt, 'Crie um resumo do projeto');

  Object.assign(newReq, {
    readyState: 4, status: 200,
    responseText: JSON.stringify({ ok: true, id: 'm0:00000000-0000-4000-8000-000000000123', machine: 'MateusNote', tool: 'Claude Code' }),
  });
  newReq.onreadystatechange();
  assert.equal(context.location.hash, 's=m0%3A00000000-0000-4000-8000-000000000123');
});
