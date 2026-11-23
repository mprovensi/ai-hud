const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('HUD renderiza cartão, gaveta de uso, estatísticas e detalhe de sessão do Gemini', () => {
  const directory = path.join(__dirname, '../../web');
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  const nodes = {}, requests = [], listeners = {};
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    nodes[match[1]] = { id: match[1], style: {}, className: '', innerHTML: '', textContent: '', clientWidth: 400, clientHeight: 200,
      setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k]; } };
  }
  const byId = (id) => nodes[id] || ((id === 'burn' || id === 'burnAxis' || id === 'back' || id === 'more' || id === 'moreToggle')
    ? (nodes[id] = { style: {}, className: '', innerHTML: '', clientWidth: 400, clientHeight: 200 })
    : null);
  class XHR {
    constructor() { requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    send() {}
    setRequestHeader() {}
  }
  const now = Date.UTC(2026, 10, 23, 15, 0);
  const shortTimers = [];
  const context = {
    document: { body: { className: '' }, documentElement: {}, hidden: false, getElementById: byId, addEventListener: () => {} },
    navigator: {}, location: { search: '', hash: '' }, history: { back() {} }, XMLHttpRequest: XHR,
    Promise: undefined, fetch: undefined, localStorage: { getItem() { return null; }, setItem() {} },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    setInterval: () => {}, setTimeout: (fn, ms) => { if ((ms || 0) <= 100) shortTimers.push(fn); return shortTimers.length; },
    clearTimeout: () => {}, innerWidth: 1024,
  };
  const flushTimers = () => { while (shortTimers.length) shortTimers.shift()(); };
  context.window = context;
  vm.runInNewContext(require('../helpers/app-source'), context);

  const snap = {
    now, tz: -180, remoteMode: false,
    quotas: {
      claude: { plan: 'max', at: now, windows: {} },
      codex: { plan: 'plus', at: now, windows: {} },
      gemini: {
        plan: 'Gemini Pro', at: now,
        windows: {
          pro: { used: 42, resetsAt: now + 6 * 3600e3, modelId: 'gemini-2.5-pro', pace: { expected: 75, projected: 56, runsOutIn: null, basis: 'average' } },
          flash: { used: 12, resetsAt: now + 6 * 3600e3, modelId: 'gemini-2.5-flash', pace: { expected: 75, projected: 16, runsOutIn: null, basis: 'average' } },
        },
        extraGroups: [
          {
            name: 'Claude and GPT models',
            windows: {
              five_hour: { used: 18, resetsAt: now + 3 * 3600e3, pace: { expected: 40, projected: 45, runsOutIn: null, basis: 'average' } },
              seven_day: { used: 5, resetsAt: now + 5 * 86400e3, pace: { expected: 29, projected: 17, runsOutIn: null, basis: 'average' } },
            },
          },
          {
            name: 'Gemini 4 Argon',
            windows: {
              seven_day: { used: 30, resetsAt: now + 5 * 86400e3, pace: { expected: 29, projected: 100, runsOutIn: null, basis: 'average' } },
            },
          },
        ],
      },
    },
    burn: {
      gemini: { start: now - 18 * 3600e3, end: now + 6 * 3600e3, used: 42, window: 'pro', points: [[now - 18 * 3600e3, 0], [now, 42]], projected: 56, runsOutIn: null },
    },
    today: { 'Claude Code': { fresh: 1000, cacheRead: 0 }, Codex: { fresh: 2000, cacheRead: 0 }, Gemini: { fresh: 158000, cacheRead: 1600000 } },
    sessionsToday: { 'Claude Code': 1, Codex: 1, Gemini: 2, Antigravity: 0, Ollama: 0 },
    hours: [{ t: now - 3600e3, 'Claude Code': 1000, Codex: 2000, Gemini: 158000 }],
    days: [{ t: now - 86400e3, 'Claude Code': 1000, Codex: 2000, Gemini: 158000 }],
    active: [{
      tool: 'Gemini', id: '00000000-0000-4000-8000-000000000001', where: 'antigravity', project: 'ai-hud', title: 'Adicionar Gemini',
      start: now - 600e3, end: now - 10e3, state: 'working', lastTool: 'edit_file',
      tokens: 158000, prompts: 2, lastPrompt: 'adicione gemini', lastReply: '', context: 150000, contextWindow: 1e6,
    }],
    recent: [],
    ollamas: [],
  };
  Object.assign(requests[0], { readyState: 4, status: 200, responseText: JSON.stringify(snap) });
  requests[0].onreadystatechange();

  // Cartão superior do Gemini
  assert.match(nodes['q-gemini'].innerHTML, /Gemini/);
  assert.match(nodes['q-gemini'].innerHTML, /158k/);
  assert.match(nodes['q-gemini'].innerHTML, /Pro/);
  assert.match(nodes['q-gemini'].innerHTML, /42%/);
  assert.match(nodes['q-gemini'].innerHTML, /Fla/);
  assert.match(nodes['q-gemini'].innerHTML, /brand-gemini\.svg/);
  assert.doesNotMatch(nodes['q-gemini'].innerHTML, /Gemini 4 Argon/);

  // Cartão de sessão mostra tokens (não só "pedidos")
  assert.match(nodes.sessList.innerHTML, /158k tokens/);
  assert.match(nodes.sessList.innerHTML, /brand-gemini\.svg/);

  const goHash = (h) => { context.location.hash = h; for (const fn of listeners.hashchange || []) fn(); flushTimers(); };

  // Gaveta #uso=gemini
  nodes['q-gemini'].onclick();
  assert.equal(context.location.hash, 'uso=gemini');
  goHash('#uso=gemini');
  assert.match(nodes.overlayBody.innerHTML, /Cota diária · Pro/);
  assert.match(nodes.overlayBody.innerHTML, /gemini-2\.5-pro/);
  assert.match(nodes.overlayBody.innerHTML, /Outras cotas do Antigravity/);
  assert.match(nodes.overlayBody.innerHTML, /Claude e GPT \(Antigravity\)/);
  assert.match(nodes.overlayBody.innerHTML, /Gemini 4 Argon/);
  assert.match(nodes.overlayBody.innerHTML, /Janela de 24h · uso e projeção/);
  assert.match(nodes.overlayBody.innerHTML, /158k/);
  assert.match(nodes.overlayBody.innerHTML, /Sessões ativas · 1/);
  assert.match(nodes.burn.innerHTML, /<svg/);

  // Gaveta #estatisticas inclui Gemini nos totais e barras empilhadas
  goHash('#estatisticas');
  assert.match(nodes.overlayBody.innerHTML, /<span class="dot c2"><\/span>Gemini/);
  assert.match(nodes.overlayBody.innerHTML, /158k/);
  assert.match(nodes.overlayBody.innerHTML, /#7d9bf0/);

  // Gaveta #s=<uuid> mostra origem (Antigravity), botão Abrir no PC e caixa de resposta
  const reqBefore = requests.length;
  goHash('#s=00000000-0000-4000-8000-000000000001');
  assert.equal(requests.length, reqBefore + 1);
  Object.assign(requests[reqBefore], {
    readyState: 4, status: 200,
    responseText: JSON.stringify({
      tool: 'Gemini', id: '00000000-0000-4000-8000-000000000001', key: '00000000-0000-4000-8000-000000000001',
      where: 'antigravity', project: 'ai-hud', title: 'Adicionar Gemini',
      cwd: 'd:/Projetos/ai-hud', models: ['Gemini 3 Pro'], start: now - 600e3, end: now - 10e3,
      state: 'waiting', now, input: 145000, output: 13000, cacheRead: 1600000, cacheWrite: 0,
      context: 150000, contextWindow: 1e6, prompts: 2, toolCalls: 12, lastTool: 'edit_file',
      tools: [['edit_file', 5]], files: [['web/js/drawers/detail.js', 3], ['src/views/session-detail.js', 1]],
      lastPrompt: 'adicione gemini', lastReply: 'Pronto!', lastReplyAt: now - 10e3,
      subagents: 0, subTokens: 0, turns: [{ t: now - 20e3, fresh: 5000, cacheRead: 100000 }], history: null,
    }),
  });
  requests[reqBefore].onreadystatechange();
  assert.match(nodes.overlayBody.innerHTML, /Gemini · Antigravity/);
  assert.match(nodes.overlayBody.innerHTML, /<span>Origem<\/span><span>Antigravity<\/span>/);
  assert.match(nodes.overlayBody.innerHTML, /Arquivos modificados · 2/);
  assert.match(nodes.overlayBody.innerHTML, /web\/js\/drawers\/detail\.js/);
  assert.match(nodes.overlayBody.innerHTML, /3×/);
  assert.match(nodes.overlayBody.innerHTML, /id="focusPc"/);
  // Sessão da IDE Antigravity mostra aviso + botão de Handoff em vez da caixa de resposta (que falharia no agy CLI)
  assert.doesNotMatch(nodes.overlayBody.innerHTML, /id="replyText"/);
  assert.match(nodes.overlayBody.innerHTML, /id="openHandoffIde"/);

  // Sessão criada pelo Antigravity CLI (`antigravity-cli`, ex.: via + Nova ou terminal) exibe a caixa de resposta
  const reqLinux = requests.length;
  goHash('#s=00000000-0000-4000-8000-000000000002');
  Object.assign(requests[reqLinux], {
    readyState: 4, status: 200,
    responseText: JSON.stringify({
      tool: 'Gemini', id: '00000000-0000-4000-8000-000000000002', key: '00000000-0000-4000-8000-000000000002',
      where: 'antigravity-cli', canFocus: false, project: 'vps-app', title: 'Sessão na VPS',
      cwd: '/home/ubuntu/vps-app', models: ['gemini-2.5-pro'], start: now - 600e3, end: now - 10e3,
      state: 'waiting', now, input: 1000, output: 200, cacheRead: 0, cacheWrite: 0,
      context: 1200, contextWindow: 1e6, prompts: 1, toolCalls: 0, lastTool: '',
      tools: [], files: [], lastPrompt: 'oi', lastReply: 'olá', lastReplyAt: now - 10e3,
      subagents: 0, subTokens: 0, turns: [], history: null,
    }),
  });
  requests[reqLinux].onreadystatechange();
  assert.doesNotMatch(nodes.overlayBody.innerHTML, /id="focusPc"/);
  assert.match(nodes.overlayBody.innerHTML, /id="replyText"/);
});
