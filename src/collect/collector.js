// Coletor: um laço único lê as fontes, guarda as sessões e o snapshot pronto, e muda a versão só quando
// o conteúdo muda. As rotas leem daqui em vez de reler os logs a cada requisição, e quem pergunta
// "mudou desde a versão X?" espera a mudança (long-polling) em vez de consultar a cada 10 s.
//
//   sources.all()            sessões deste PC (collect/sources)
//   build(sessions, now)     snapshot pronto para os aparelhos (views + federação)
//
// Sem ninguém olhando há mais de idleMs, o laço para de ler; a próxima requisição lê na hora.
const crypto = require('crypto');

// Campos que mudam com o relógio mesmo sem nada acontecer (hora da leitura, ritmo e gráfico das cotas):
// ficam fora da comparação; vão atualizados na próxima resposta (no máximo a cada espera do long-polling)
const CLOCK_KEYS = new Set(['now', 'at', 'errorAt', 'pace', 'burn']);
const ignoreClock = (key, value) => (CLOCK_KEYS.has(key) ? undefined : value);

function createCollector({ sources, build, intervalMs = 2000, idleMs = 60e3, now = () => Date.now() }) {
  // A versão muda a cada reinício (boot) e a cada mudança de conteúdo: um aparelho com a versão do
  // processo anterior recebe a resposta na hora
  const boot = crypto.randomBytes(3).toString('hex');
  let count = 0, hash = '', at = 0, sessions = [], snapshot = null, version = `${boot}-0`, demand = 0, timer = null;
  const waiters = new Set();

  function collect() {
    const t = now();
    sessions = sources.all();
    snapshot = build(sessions, t);
    at = t;
    const h = crypto.createHash('sha1').update(JSON.stringify(snapshot, ignoreClock)).digest('hex');
    if (h !== hash) {
      hash = h;
      version = `${boot}-${++count}`;
      for (const w of [...waiters]) w();
    }
  }

  // Estado atual; relê se o último ciclo tem mais de maxAgeMs (ou nunca rodou)
  function current(maxAgeMs = intervalMs) {
    demand = now();
    if (!snapshot || now() - at > maxAgeMs) collect();
    return { sessions, snapshot, version };
  }

  // Resolve quando a versão for diferente de `since`, ou depois de timeoutMs
  function waitChange(since, timeoutMs) {
    demand = now();
    if (since !== version) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); waiters.delete(done); resolve(); };
      const t = setTimeout(done, timeoutMs);
      waiters.add(done);
    });
  }

  return {
    current,
    waitChange,
    // Algo mudou por uma ação (resposta, permissão, peer): relê já, sem esperar o próximo ciclo
    poke() { if (snapshot) collect(); },
    find(predicate) { return current().sessions.find(predicate); },
    start() {
      timer = setInterval(() => { if (waiters.size || now() - demand < idleMs) collect(); }, intervalMs);
      return timer;
    },
    stop() { clearInterval(timer); for (const w of [...waiters]) w(); },
  };
}

module.exports = { createCollector };
