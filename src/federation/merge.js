// Junta o snapshot deste PC com os dos secundários que estão respondendo. Função pura.
const { compareSessions } = require('../core/session');

function mergeSeries(target, source) {
  const byTime = new Map(target.map((row) => [row.t, row]));
  for (const row of source || []) {
    const match = byTime.get(row.t);
    if (!match) continue;
    for (const tool of ['Claude Code', 'Codex']) match[tool] += row[tool] || 0;
  }
}

// Ids de sessões remotas ganham o prefixo "m<n>:" (n = posição do PC em config.peers)
const tag = (list, p) => (list || []).map((s) => ({ ...s, id: `m${p.i}:${s.id}`, machine: p.name }));

// list: todos os peers; live: os que responderam há pouco; ollamasFor(p, conectado): Ollamas do PC p
function mergeSnapshots({ local, localName, list, live, ollamasFor }) {
  const out = { ...local };
  out.machines = [{ name: localName, ok: true },
    ...list.map((p) => ({ name: p.name, ok: live.includes(p), error: p.error }))];
  const mine = (sessions) => (sessions || []).map((s) => ({ ...s, machine: localName }));
  out.active = mine(local.active);
  out.recent = mine(local.recent);
  // Ollama: um item por máquina que tem Ollama (o secundário já manda a lista dele)
  out.ollamas = local.ollama ? [{ ...local.ollama, machine: localName }] : [];
  delete out.ollama;
  for (const p of list) {
    // PC sem resposta: o Ollama dele aparece fora do ar, marcado como sem conexão com o PC
    out.ollamas = out.ollamas.concat(ollamasFor(p, live.includes(p)));
  }
  if (!live.length) return out;

  for (const p of live) {
    out.active = out.active.concat(tag(p.snap.active, p));
    out.recent = out.recent.concat(tag(p.snap.recent, p));
  }
  out.active.sort(compareSessions);
  out.recent = out.recent.sort((a, b) => b.end - a.end).slice(0, 40);

  // Snapshots podem atravessar a virada da hora/dia: alinha os intervalos pelo timestamp.
  out.today = JSON.parse(JSON.stringify(local.today));
  out.sessionsToday = { ...local.sessionsToday };
  out.hours = local.hours.map((h) => ({ ...h }));
  out.days = local.days.map((d) => ({ ...d }));
  for (const p of live) {
    const s = p.snap;
    for (const tool of Object.keys(out.today)) {
      if (!s.today || !s.today[tool]) continue;
      out.today[tool].fresh += s.today[tool].fresh;
      out.today[tool].cacheRead += s.today[tool].cacheRead;
    }
    for (const tool of Object.keys(out.sessionsToday)) out.sessionsToday[tool] += (s.sessionsToday && s.sessionsToday[tool]) || 0;
    mergeSeries(out.hours, s.hours);
    mergeSeries(out.days, s.days);
  }

  // Cotas: mesma conta nos dois PCs = mesma janela (reset igual) → vale a leitura mais recente
  out.quotas = { ...local.quotas };
  for (const name of ['claude', 'codex']) {
    const reset = (q) => q && q.windows && q.windows.seven_day && q.windows.seven_day.resetsAt;
    let best = local.quotas[name];
    for (const p of live) {
      const q = p.snap.quotas && p.snap.quotas[name];
      if (!q || !reset(q)) continue;
      const same = !reset(best) || Math.abs(reset(q) - reset(best)) < 120e3;
      if (same && (!best || !best.at || (q.at || 0) > best.at)) best = q;
    }
    out.quotas[name] = best;
  }
  return out;
}

module.exports = { mergeSnapshots };
