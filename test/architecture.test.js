// O sentido das dependências entre as camadas de src/ (docs/system-design.md):
//   api → views / actions / federation → collect → core      (infra serve a todas)
// e as integrações (que rodam dentro de outras ferramentas) não dependem do servidor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
// Camadas que cada uma pode usar (além dela mesma)
const ALLOWED = {
  core: [],
  infra: [],
  collect: ['core', 'infra'],
  views: ['core', 'infra'],
  federation: ['core', 'infra'],
  actions: ['collect', 'core', 'infra'],
  api: ['views', 'actions', 'federation', 'collect', 'core', 'infra'],
};

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const requires = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/require\('(\.[^']+)'\)/g)].map((m) => path.resolve(path.dirname(file), m[1]));
const layerOf = (file) => path.relative(SRC, file).split(path.sep)[0];

test('cada camada de src/ só usa as camadas abaixo dela', () => {
  const problems = [];
  for (const file of walk(SRC).filter((f) => f.endsWith('.js'))) {
    const from = layerOf(file);
    if (!ALLOWED[from]) continue; // main.js monta tudo
    for (const target of requires(file)) {
      if (!target.startsWith(SRC)) { problems.push(`${path.relative(ROOT, file)} usa algo fora de src/`); continue; }
      const to = layerOf(target);
      if (to !== from && !ALLOWED[from].includes(to)) problems.push(`${path.relative(ROOT, file)} (${from}) usa ${to}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('core/ não lê arquivos, rede nem processos', () => {
  for (const file of walk(path.join(SRC, 'core'))) {
    const s = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(s, /require\('(fs|http|https|net|child_process)'\)/, path.relative(ROOT, file));
  }
});

test('o app dos aparelhos e as integrações não importam o servidor', () => {
  for (const dir of ['web', 'integrations/vscode-terminal', 'integrations/ollama-proxy']) {
    for (const file of walk(path.join(ROOT, dir)).filter((f) => f.endsWith('.js'))) {
      assert.ok(!requires(file).some((t) => t.startsWith(SRC)), path.relative(ROOT, file));
    }
  }
});
