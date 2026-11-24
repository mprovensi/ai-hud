const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const app = require('../helpers/app-source');

function createDetailHarness() {
  const start = app.indexOf('  function ollamaRuntime(d)');
  const end = app.indexOf('\n  function renderRecent()', start);
  assert.ok(start >= 0 && end > start);

  let html = '';
  const posted = [];
  const flashes = [];
  const mockButtons = [];
  const mockInputs = [];
  const nodes = {};

  function makeNode(id, extra = {}) {
    return Object.assign({
      id, className: '', innerHTML: '', value: '', disabled: false, scrollTop: 0, scrollHeight: 100,
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; },
      blur() {},
      getElementsByTagName(tag) { return tag === 'button' ? mockButtons : tag === 'input' ? mockInputs : []; },
    }, extra);
  }

  for (const id of ['tabConvo', 'tabDetails', 'paneConvo', 'paneDetails', 'qbox', 'qSend', 'qDeny',
    'replyText', 'sendReply', 'toggleChips', 'quickChips', 'overlayBody', 'lastReply']) {
    nodes[id] = makeNode(id);
  }
  nodes.lastReply.className = 'convo lastreply';
  let focusCount = 0;
  nodes.lastReply.focus = () => { focusCount++; };

  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const context = {
    window: { isSecureContext: false },
    document: { activeElement: null, body: {}, createElement: () => makeNode('rflash') },
    snap: { ollamas: [] },
    moreOpen: false,
    sessHead: (x) => '<h1>' + x.project + '</h1>',
    stat: (v, k) => '<div>' + v + ' ' + k + '</div>',
    esc: escape,
    k: (n) => String(n),
    dur: (ms) => Math.floor(ms / 60000) + 'min',
    when: () => '11:30',
    hm: () => '11:30',
    gb: (b) => (b / 1e9).toFixed(1) + ' GB',
    levelFill: () => '#5d86bd',
    $: (id) => nodes[id] || null,
    setOverlay: (v) => {
      html = v;
      mockButtons.length = 0;
      mockInputs.length = 0;
      for (const m of v.matchAll(/<button[^>]*data-qi="(\d+)"[^>]*data-oi="(\d+)"[^>]*>/g)) {
        mockButtons.push(makeNode('', { attrs: { 'data-qi': m[1], 'data-oi': m[2] } }));
      }
      for (const m of v.matchAll(/<button[^>]*data-chip="([^"]+)"[^>]*>/g)) {
        mockButtons.push(makeNode('', { attrs: { 'data-chip': m[1] } }));
      }
      for (const m of v.matchAll(/<input[^>]*data-qi="(\d+)"[^>]*>/g)) {
        mockInputs.push(makeNode('', { attrs: { 'data-qi': m[1] } }));
      }
    },
    isSeen: () => false,
    rememberViewed: () => {},
    request: (method, url, cb, body) => { posted.push({ method, url, body }); cb(null, { sent: true }); },
    alert: () => {},
    setTimeout: () => {},
  };
  vm.runInNewContext(app.slice(start, end) + '\nthis.renderDetail = renderDetail; this.renderMd = renderMd; this.typing = typing;', context);
  // Captura flash
  context.flash = (m) => flashes.push(m);
  return { context, nodes, posted, flashes, mockButtons, mockInputs, html: () => html, focusCount: () => focusCount };
}

test('renderMd formata títulos, negrito, código, listas e tabelas escapando HTML (sem XSS)', () => {
  const { context } = createDetailHarness();
  const out = context.renderMd([
    '### Resumo <script>alert(1)</script>',
    'Use **negrito**, *itálico* e `npm test`.',
    '',
    '- Item 1',
    '- Item 2',
    '',
    '| Col A | Col B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```js',
    'const x = a < b && "**não negrito**";',
    '```',
  ].join('\n'));
  assert.match(out, /<div class="md-h md-h3">Resumo &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/div>/);
  assert.match(out, /<b>negrito<\/b>/);
  assert.match(out, /<i>itálico<\/i>/);
  assert.match(out, /<code class="md-code">npm test<\/code>/);
  assert.match(out, /<ul class="md-ul"><li>Item 1<\/li><li>Item 2<\/li><\/ul>/);
  assert.match(out, /<table><thead><tr><th>Col A<\/th><th>Col B<\/th><\/tr><\/thead>/);
  assert.match(out, /<pre class="md-pre"><code>const x = a &lt; b &amp;&amp; &quot;\*\*não negrito\*\*&quot;;<\/code><\/pre>/);
  assert.ok(!out.includes('<script>'));
});

test('detalhe renderiza histórico em chat com ferramentas, abas e cartão interativo de múltipla escolha', () => {
  const h = createDetailHarness();
  const now = Date.UTC(2026, 10, 23, 14, 30);
  const d = {
    id: 'claude-1', key: 'claude-1', tool: 'Claude Code', where: 'vscode', project: 'ai-hud',
    title: 'Melhorar conversa', cwd: 'D:\\Projetos\\ai-hud', models: ['claude-opus'],
    start: now - 300e3, end: now - 10e3, state: 'permission', now,
    input: 5000, output: 1000, cacheRead: 20000, cacheWrite: 0, context: 25000, contextWindow: 200000,
    prompts: 2, toolCalls: 4, tools: [['Edit', 3]], turns: [], lastPrompt: 'proponha melhoria',
    lastReply: 'Qual opção prefere?', lastReplyAt: now - 10e3,
    permission: { id: 'perm-1', tool: 'AskUserQuestion', summary: 'Qual opção?' },
    history: [
      { role: 'user', content: 'proponha melhoria', at: now - 60e3 },
      { role: 'assistant', content: '### Proposta\nVeja **as opções** abaixo.', at: now - 10e3, tools: ['Read', 'Edit', 'Edit'] },
    ],
    question: {
      mode: 'permission',
      permissionId: 'perm-1',
      questions: [{
        id: 'q0', header: 'Navegação', question: 'Como prefere organizar?', multiSelect: false,
        options: [
          { key: '1', label: 'Abas', description: 'Conversa e Detalhes' },
          { key: '2', label: 'Rolagem', description: 'Tudo junto' },
        ],
      }],
    },
  };

  h.context.renderDetail(d);
  assert.equal(h.focusCount(), 1, 'ao abrir a sessão o foco vai direto para a conversa');
  assert.match(h.html(), /⚙ 3 ferramentas · Read, Edit/);
  assert.match(h.html(), /<b>as opções<\/b>/);
  assert.match(h.html(), /Navegação/);
  assert.match(h.html(), /Conversa e Detalhes/);
  assert.equal(h.nodes.qSend.disabled, true);
  assert.equal(h.context.typing(), false);

  // Seleciona a primeira opção ("Abas")
  const qOpts = h.mockButtons.filter((b) => b.getAttribute('data-oi') != null);
  assert.equal(qOpts.length, 2);
  qOpts[0].onclick();
  assert.equal(qOpts[0].className, 'qopt sel');
  assert.equal(h.nodes.qSend.disabled, false);
  assert.equal(h.context.typing(), true, 'polling não deve sobrescrever seleção em andamento');

  // Envia resposta ao hook de permissão do Claude
  h.nodes.qSend.onclick();
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].url, '/api/permission');
  assert.equal(h.posted[0].body.decision, 'answer');
  assert.deepEqual({ ...h.posted[0].body.answers }, { 'Como prefere organizar?': 'Abas' });

  // Alternância de abas Conversa <-> Detalhes
  h.nodes.tabDetails.onclick();
  assert.equal(h.nodes.paneDetails.className, 'dtab-pane active');
  assert.equal(h.nodes.paneConvo.className, 'dtab-pane');
});

test('atalhos contextuais aparecem visíveis e tocam para preencher a caixa de texto sem enviar', () => {
  const h = createDetailHarness();
  const now = Date.UTC(2026, 10, 23, 15, 0);
  h.context.renderDetail({
    id: 'claude-2', key: 'claude-2', tool: 'Claude Code', where: 'vscode', project: 'ai-hud',
    title: 'Proposta', cwd: 'D:\\Projetos\\ai-hud', models: ['claude-opus'],
    start: now - 60e3, end: now - 5e3, state: 'waiting', now,
    input: 100, output: 50, cacheRead: 0, cacheWrite: 0, context: 100, contextWindow: 200000,
    prompts: 1, toolCalls: 0, tools: [], turns: [], lastPrompt: 'proponha',
    lastReply: 'Posso implementar?', lastReplyAt: now - 5e3,
    history: [{ role: 'assistant', content: 'Posso implementar?', at: now - 5e3 }],
    question: null,
    canStop: true,
    suggestions: ['Sim, implemente', 'Ajuste a proposta', 'Explique melhor'],
  });
  assert.match(h.html(), /id="suggChips"/);
  assert.match(h.html(), /⚡ Mais/);
  const suggChips = h.mockButtons.filter((b) => b.getAttribute('data-chip'));
  assert.equal(suggChips[0].getAttribute('data-chip'), 'Sim', 'primeira resposta rápida deve ser Sim');
  assert.ok(h.html().indexOf('id="stopTurn"') > h.html().indexOf('id="sendReply"'), 'botão de parar deve ficar abaixo do bloco Responder');
  const chip = h.mockButtons.find((b) => b.getAttribute('data-chip') === 'Sim, implemente');
  assert.ok(chip);
  chip.onclick();
  assert.equal(h.nodes.replyText.value, 'Sim, implemente');
  assert.equal(h.posted.length, 0, 'toque no atalho apenas preenche a caixa de texto');
});
