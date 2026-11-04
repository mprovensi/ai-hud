const test = require('node:test');
const assert = require('node:assert/strict');
const { createCollector } = require('../../src/collect/collector');

function fixture() {
  let sessions = [], clock = 1000, reads = 0;
  const collector = createCollector({
    sources: { all: () => { reads++; return sessions; } },
    build: (list, now) => ({ now, at: now, quotas: { claude: { at: now, pace: { expected: now } } }, active: list.map((s) => ({ id: s })) }),
    now: () => clock,
  });
  return { collector, set: (s) => { sessions = s; }, advance: (ms) => { clock += ms; }, reads: () => reads };
}

test('a versão só muda quando o conteúdo muda, não com o relógio', () => {
  const f = fixture();
  const v1 = f.collector.current().version;
  f.advance(5000);
  f.collector.poke();
  assert.equal(f.collector.current().version, v1, 'now, at e o ritmo das cotas mudaram, mas nada aconteceu');
  f.set(['a']);
  f.collector.poke();
  assert.notEqual(f.collector.current().version, v1);
});

test('lê as fontes no máximo uma vez por ciclo, por mais requisições que cheguem', () => {
  const f = fixture();
  f.collector.current();
  for (let i = 0; i < 10; i++) f.collector.current();
  assert.equal(f.reads(), 1);
  f.advance(2500);
  f.collector.current();
  assert.equal(f.reads(), 2, 'ciclo vencido: relê');
});

test('quem espera uma versão é avisado quando ela muda', async () => {
  const f = fixture();
  const { version } = f.collector.current();
  let woke = false;
  const waiting = f.collector.waitChange(version, 5000).then(() => { woke = true; });
  f.set(['b']);
  f.collector.poke();
  await waiting;
  assert.equal(woke, true);
  await f.collector.waitChange('outra-versao', 5000); // versão diferente da atual: não espera
});
