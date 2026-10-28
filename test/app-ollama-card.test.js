const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = app.indexOf('  function gb('), end = app.indexOf('  var GRID_MIN =', start);
assert.ok(start >= 0 && end > start);
function client() {
  const node = { style: {}, innerHTML: '' }, overlays = [];
  const context = { $: () => node, esc: String, ollamaIcon: () => '', hm: () => '', when: () => '',
    head: (title) => title, setOverlay: (html) => overlays.push(html) };
  vm.runInNewContext(app.slice(start, end), context);
  return { c: context, node, overlays };
}
const snapshot = (ollamas) => ({ ollamas, active: [], recent: [], machines: [{ name: 'local' }, { name: 'PC-Desktop' }] });

test('the Ollama card remains visible without telemetry and while the desktop is disconnected', () => {
  const { c, node } = client();
  c.ollamaPanel(snapshot([]));
  assert.equal(node.style.display, '');
  assert.match(node.innerHTML, /Ollama/);
  assert.match(node.innerHTML, /Aguardando informações/);
  c.ollamaPanel(snapshot([{ machine: 'PC-Desktop', online: false, unreachable: true, models: [], gpu: null }]));
  assert.equal(node.style.display, '');
  assert.match(node.innerHTML, /PC-Desktop/);
  assert.match(node.innerHTML, /PC sem conexão/);
});

test('offline Ollama details do not claim that no models are loaded on the remote PC', () => {
  const { c, overlays } = client();
  c.snap = snapshot([{ machine: 'PC-Desktop', online: false, unreachable: true, models: [], gpu: null }]);
  c.renderOllama();
  assert.match(overlays[0], /Modelos indisponíveis para consulta: PC sem conexão/);
  assert.ok(!overlays[0].includes('Nenhum agora'));
});
