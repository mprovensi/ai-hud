// Leituras de cota de cada IA e histórico em data/quota-history.json. As contas (ritmo, projeção,
// gráfico da janela de 5h) ficam em core/quota-pace.js.
const { readJson, writeJson } = require('../../infra/store');
const { burn, quotasWithPace, expired } = require('../../core/quota-pace');

// fetchers: { claude: async () => ({ plan, windows }), codex: ... }
function createQuotaTracker({ historyFile, fetchers }) {
  const history = readJson(historyFile, {});
  const quotas = Object.fromEntries(Object.keys(fetchers).map((name) => [name, null]));
  let lastRefresh = 0;

  function record(name, q) {
    const now = Date.now();
    for (const [key, w] of Object.entries(q.windows || {})) {
      if (!w) continue;
      let h = history[`${name}.${key}`];
      // resetsAt mudou: começou uma janela nova, as amostras antigas não servem
      if (!h || Math.abs(h.resetsAt - w.resetsAt) > 60e3) h = history[`${name}.${key}`] = { resetsAt: w.resetsAt, samples: [] };
      // Guarda a janela inteira (o gráfico de 5h usa todas); ~2000 amostras numa semana a cada 5 min
      h.samples = h.samples.concat([[now, w.used]]).slice(-2500);
    }
    writeJson(historyFile, history);
  }

  async function refresh(name) {
    const prev = quotas[name] || {};
    try {
      quotas[name] = { ...(await fetchers[name]()), at: Date.now(), error: null };
      record(name, quotas[name]);
    } catch (e) {
      // Falha passageira com leitura anterior recente: mantém os números sem alarde.
      // Só mostra o aviso se a última leitura boa tiver mais de 10 min.
      const fresh = prev.windows && Object.keys(prev.windows).length && Date.now() - (prev.at || 0) < 10 * 60e3;
      quotas[name] = e.soft && fresh ? prev : { ...prev, error: e.message, errorAt: Date.now() };
    }
  }

  function refreshAll() {
    lastRefresh = Date.now();
    return Promise.all(Object.keys(fetchers).map(refresh));
  }

  return {
    refreshAll,
    view: (now) => quotasWithPace(quotas, history, now),
    burn: (now, codexSessions) => burn(quotas, history, now, codexSessions),
    expired: (now) => expired(quotas, now),
    sinceRefresh: (now) => now - lastRefresh,
  };
}

module.exports = { createQuotaTracker };
