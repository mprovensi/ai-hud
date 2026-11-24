const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bootLegacyHud() {
  const directory = path.join(__dirname, '../../web');
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  const nodes = {};
  const requests = [];
  const winListeners = {};

  const makeNode = (id) => {
    let inner = '';
    const node = {
      id,
      style: {},
      className: '',
      textContent: '',
      value: '',
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] || null; },
      querySelectorAll() { return []; },
      getElementsByTagName() { return []; },
      focus() {},
    };
    Object.defineProperty(node, 'innerHTML', {
      get() { return inner; },
      set(v) {
        inner = String(v);
        for (const m of inner.matchAll(/\bid="([^"]+)"/g)) {
          if (!nodes[m[1]]) nodes[m[1]] = makeNode(m[1]);
        }
      },
    });
    return node;
  };

  for (const m of html.matchAll(/\bid="([^"]+)"/g)) nodes[m[1]] = makeNode(m[1]);

  class XHR {
    constructor() {
      this.method = '';
      this.url = '';
      requests.push(this);
    }
    open(method, url) { this.method = method; this.url = url; }
    send() {}
    setRequestHeader() {}
    respond(status, body) {
      this.readyState = 4;
      this.status = status;
      this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
      if (this.onreadystatechange) this.onreadystatechange();
    }
  }

  const timers = [];
  const context = {
    document: {
      body: { className: '' },
      documentElement: {},
      hidden: false,
      getElementById: (id) => nodes[id] || null,
      addEventListener: () => {},
    },
    navigator: {},
    location: { search: '', hash: '' },
    history: {},
    XMLHttpRequest: XHR,
    Promise: undefined,
    fetch: undefined,
    localStorage: { getItem() { return null; }, setItem() {} },
    addEventListener: (name, fn) => { winListeners[name] = fn; },
    setInterval: () => {},
    setTimeout: (fn, ms) => { if (ms <= 50) timers.push(fn); },
    innerWidth: 1024,
  };
  context.window = context;
  vm.runInNewContext(require('../helpers/app-source'), context);

  return {
    context,
    nodes,
    requests,
    winListeners,
    flushTimers() { while (timers.length) timers.shift()(); },
  };
}

test('AI HUD: botão Ler nos detalhes da sessão é apenas ícone discreto e gaveta de uso exibe valor monetário', () => {
  const { context, nodes, requests, winListeners, flushTimers } = bootLegacyHud();
  const now = Date.now();

  requests[0].respond(200, {
    now,
    active: [{
      id: 'sess-1',
      tool: 'Claude Code',
      project: 'ai-hud',
      title: 'Ajuste HUD',
      state: 'waiting',
      start: now - 60000,
      end: now - 1000,
      lastReply: 'Tudo pronto.',
      lastReplyAt: now - 1000,
    }],
    recent: [],
    quotas: {
      claude: {
        plan: 'max',
        at: now,
        windows: {
          five_hour: { used: 35, resetsAt: now + 3600e3 },
        },
      },
    },
    costs: {
      usdToBrl: 5.75,
      fxSource: 'live',
      today: { 'Claude Code': { usd: 4.2, input: 120000, output: 15000, cacheRead: 300000, cacheWrite: 0 } },
      week: { 'Claude Code': { usd: 28.5 } },
      month: { 'Claude Code': { usd: 95.1 } },
    },
    today: { 'Claude Code': { fresh: 135000, cacheRead: 300000 } },
    sessionsToday: { 'Claude Code': 2 },
    hours: [],
    days: [],
  });

  // 1. Abrir detalhes de uso do Claude e validar segmento de valor monetário
  context.location.hash = '#uso=claude';
  winListeners.hashchange();
  flushTimers();
  const usageHtml = nodes.overlayBody.innerHTML;
  assert.match(usageHtml, /Valor equivalente \(API\)/);
  assert.match(usageHtml, /US\$ 1 = R\$ 5,75/);
  assert.match(usageHtml, /US\$ 4,20/);
  assert.match(usageHtml, /R\$ 24,15/);
  assert.match(usageHtml, /US\$ 28,50/);
  assert.match(usageHtml, /US\$ 95,10/);

  // 2. Abrir detalhe da sessão e validar botão Ler apenas com ícone discreto (sem texto "Ler")
  context.location.hash = '#s=sess-1';
  winListeners.hashchange();
  const detailReq = requests.find((r) => r.url.indexOf('/api/session?id=sess-1') !== -1);
  assert.ok(detailReq, 'esperava requisição de detalhe da sessão');
  detailReq.respond(200, {
    id: 'sess-1',
    tool: 'Claude Code',
    project: 'ai-hud',
    title: 'Ajuste HUD',
    state: 'waiting',
    start: now - 60000,
    end: now - 1000,
    lastPrompt: 'Oi',
    lastReply: 'Resposta final concluída.',
    lastReplyAt: now - 1000,
    models: [],
    tools: [],
    turns: [],
    files: [],
    subagents: 0,
    history: [
      { role: 'user', content: 'Oi', at: now - 5000 },
      { role: 'assistant', content: 'Resposta final concluída.', at: now - 1000 },
    ],
  });
  const detailHtml = nodes.overlayBody.innerHTML;
  const speakBtnMatch = detailHtml.match(/<button[^>]*id="speakLast"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(speakBtnMatch, 'esperava botão speakLast');
  assert.match(speakBtnMatch[0], /class="speak-ico"/);
  assert.match(speakBtnMatch[1], /<svg\b/);
  assert.doesNotMatch(speakBtnMatch[1], /Ler|🔊/);
});

test('AI HUD: AI Workspace simplificado carrega Cards via board portátil, usa renderMd e remove aba Notas', () => {
  const { context, nodes, requests, winListeners } = bootLegacyHud();

  requests[0].respond(200, {
    now: Date.now(),
    active: [],
    recent: [],
    quotas: {},
    today: {},
  });

  context.location.hash = '#workspace';
  winListeners.hashchange();

  const idxReq = requests.find((r) => r.url === '/api/workspace/index');
  assert.ok(idxReq, 'esperava GET /api/workspace/index');
  idxReq.respond(200, {
    groups: ['Pessoal', 'OcultoWS'],
    groupMeta: { OcultoWS: { hidden: true } },
    entities: [
      {
        id: 'proj-1',
        title: 'AI HUD',
        group: 'Pessoal',
        description: 'Painel de sessões',
        projectBindings: [{ machine: 'MateusNote', cwd: 'd:\\Projetos\\ai-hud' }],
      },
      {
        id: 'proj-hidden',
        title: 'Secreto',
        group: 'Pessoal',
        hidden: true,
      },
      {
        id: 'proj-in-hidden-ws',
        title: 'Dentro de Oculto',
        group: 'OcultoWS',
      },
    ],
    context: [],
    knowledge: [],
    skills: [],
    handoffs: [],
  });

  const homeHtml = nodes.wsBody.innerHTML;
  assert.match(homeHtml, /AI HUD/);
  assert.doesNotMatch(homeHtml, /Secreto/);
  assert.doesNotMatch(homeHtml, /Dentro de Oculto/);

  // Simular clique no projeto proj-1
  const fakeTarget = {
    getAttribute(k) { return k === 'data-ws-ent' ? 'proj-1' : null; },
    parentNode: nodes.wsBody,
  };
  nodes.wsBody.onclick({ target: fakeTarget });

  const entHtml = nodes.wsBody.innerHTML;
  assert.match(entHtml, /id="wsTabCards"/);
  assert.match(entHtml, /id="wsTabMem"/);
  assert.doesNotMatch(entHtml, /wsTabNotes|>Notas</);

  // Deve buscar o board portátil do projeto
  const boardReq = requests.find((r) => r.url === '/api/workspace/project/board?entityId=proj-1');
  assert.ok(boardReq, 'esperava GET /api/workspace/project/board?entityId=proj-1');
  boardReq.respond(200, {
    ok: true,
    storage: 'project',
    content: {
      format: 'ai-card',
      version: 1,
      template: 'board',
      title: 'Quadro',
      items: [
        { id: 'c1', status: 'in-progress', title: 'Refatorar Workspace leve', priority: 'high', summary: 'Usar **renderMd** sem erro.', tags: ['hud', 'ui'] },
        { id: 'c2', status: 'done', title: 'Tarefa arquivada', archived: true },
        { id: 'c3', status: 'done', title: 'Botão Ler discreto' },
      ],
    },
  });

  const paneHtml = nodes.wsEntPane.innerHTML;
  assert.match(paneHtml, /Em andamento/);
  assert.match(paneHtml, /Refatorar Workspace leve/);
  assert.match(paneHtml, /<b>renderMd<\/b>/);
  assert.match(paneHtml, /Alta/);
  assert.match(paneHtml, /Botão Ler discreto/);
  assert.doesNotMatch(paneHtml, /Tarefa arquivada/);
});
