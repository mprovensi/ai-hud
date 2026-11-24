// Junta o snapshot deste PC com os dos secundários (online e último cache de offline). Função pura.
const { compareSessions } = require('../core/session');

function dayKey(ms, tz) {
  if (!Number.isFinite(ms)) return '';
  const off = Number.isFinite(tz) ? tz : 0;
  return new Date(ms + off * 60e3).toISOString().slice(0, 10);
}

function mergeSeries(target, source, { byDay = false, targetTz = null, sourceTz = null } = {}) {
  const byTime = new Map(target.map((row) => [row.t, row]));
  // Se hub e peer estiverem em fusos diferentes (ex.: VPS em UTC e PC em BRT), alinha os dias pela data local
  const byCalDay = byDay && Number.isFinite(targetTz) && Number.isFinite(sourceTz) && targetTz !== sourceTz
    ? new Map(target.map((row) => [dayKey(row.t, targetTz), row]))
    : null;
  for (const row of source || []) {
    const match = byTime.get(row.t) || (byCalDay ? byCalDay.get(dayKey(row.t, sourceTz)) : null);
    if (!match) continue;
    for (const tool of ['Claude Code', 'Codex', 'Gemini']) {
      if (tool in match || tool in row) match[tool] = (match[tool] || 0) + (row[tool] || 0);
    }
  }
}

// Ids de sessões remotas ganham o prefixo "m<n>:" (n = posição do PC em config.peers)
const tag = (list, p) => (list || []).map((s) => ({ ...s, id: `m${p.i}:${s.id}`, machine: p.name }));

// list: todos os peers; live: os que responderam há pouco; ollamasFor(p, conectado): Ollamas do PC p
function mergeSnapshots({ local, localName, list, live, ollamasFor }) {
  const out = { ...local };
  const liveSet = new Set(live);
  out.machines = [{ name: localName, ok: true },
    ...list.map((p) => ({ name: p.name, ok: liveSet.has(p), error: p.error }))];
  const mine = (sessions) => (sessions || []).map((s) => ({ ...s, machine: localName }));
  out.active = mine(local.active);
  out.recent = mine(local.recent);
  // Ollama: um item por máquina que tem Ollama (o secundário já manda a lista dele)
  out.ollamas = local.ollama ? [{ ...local.ollama, machine: localName }] : [];
  delete out.ollama;
  for (const p of list) {
    // PC sem resposta: o Ollama dele aparece fora do ar, marcado como sem conexão com o PC
    out.ollamas = out.ollamas.concat(ollamasFor(p, liveSet.has(p)));
  }
  const withSnap = list.filter((p) => p.snap);
  if (!withSnap.length) return out;

  for (const p of live) {
    out.active = out.active.concat(tag(p.snap.active, p));
  }
  for (const p of withSnap) {
    out.recent = out.recent.concat(tag(p.snap.recent, p));
  }
  out.active.sort(compareSessions);
  out.recent = out.recent.sort((a, b) => b.end - a.end).slice(0, 40);

  // Snapshots podem atravessar a virada da hora/dia ou fusos diferentes: alinha os intervalos pelo timestamp/dia.
  out.today = JSON.parse(JSON.stringify(local.today));
  out.sessionsToday = { ...local.sessionsToday };
  out.hours = local.hours.map((h) => ({ ...h }));
  out.days = local.days.map((d) => ({ ...d }));
  if (local.costs) {
    out.costs = JSON.parse(JSON.stringify(local.costs));
  }
  const addCostGroup = (target, source) => {
    if (!target || !source) return;
    for (const tool of ['Claude Code', 'Codex', 'Gemini']) {
      if (!source[tool]) continue;
      if (!target[tool]) target[tool] = { usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      target[tool].usd = Math.round(((target[tool].usd || 0) + (source[tool].usd || 0)) * 10000) / 10000;
      target[tool].input = (target[tool].input || 0) + (source[tool].input || 0);
      target[tool].output = (target[tool].output || 0) + (source[tool].output || 0);
      target[tool].cacheRead = (target[tool].cacheRead || 0) + (source[tool].cacheRead || 0);
      target[tool].cacheWrite = (target[tool].cacheWrite || 0) + (source[tool].cacheWrite || 0);
    }
  };
  const localDay = Number.isFinite(local.now) ? dayKey(local.now, local.tz) : '';
  for (const p of withSnap) {
    const s = p.snap;
    const isLive = liveSet.has(p);
    const snapTs = Number.isFinite(s.now) ? s.now : p.at;
    const sameDay = isLive || (localDay && Number.isFinite(snapTs) && dayKey(snapTs, local.tz) === localDay);
    if (sameDay) {
      for (const tool of Object.keys(out.today)) {
        if (!s.today || !s.today[tool]) continue;
        out.today[tool].fresh += s.today[tool].fresh;
        out.today[tool].cacheRead += s.today[tool].cacheRead;
      }
      for (const tool of Object.keys(out.sessionsToday)) out.sessionsToday[tool] += (s.sessionsToday && s.sessionsToday[tool]) || 0;
      if (out.costs && s.costs && s.costs.today) addCostGroup(out.costs.today, s.costs.today);
    }
    if (out.costs && s.costs) {
      if (s.costs.week) addCostGroup(out.costs.week, s.costs.week);
      if (s.costs.month) addCostGroup(out.costs.month, s.costs.month);
      if ((!out.costs.fxUpdatedAt || out.costs.fxSource === 'fallback') && s.costs.usdToBrl && s.costs.fxSource === 'live') {
        out.costs.usdToBrl = s.costs.usdToBrl;
        out.costs.fxSource = s.costs.fxSource;
        out.costs.fxUpdatedAt = s.costs.fxUpdatedAt || 0;
      }
    }
    mergeSeries(out.hours, s.hours);
    mergeSeries(out.days, s.days, { byDay: true, targetTz: local.tz, sourceTz: s.tz });
  }

  // Cotas e burn-up: mesma conta nos PCs = mesma janela (reset igual) → vale a leitura mais recente.
  // Se o hub (ex.: VPS) não lê cota local, aproveita a dos peers online (e, sem online, o último cache ainda válido).
  out.quotas = { ...local.quotas };
  const outBurn = { ...(local.burn || {}) };
  const now = Number.isFinite(local.now) ? local.now : Date.now();
  const quotaReset = (q) => {
    const w = q && q.windows;
    if (!w) return 0;
    const picked = w.seven_day || w.five_hour || w.pro || w.daily || w.flash;
    return (picked && picked.resetsAt) || 0;
  };
  for (const name of ['claude', 'codex', 'gemini']) {
    let best = local.quotas[name];
    let bestBurn = outBurn[name];
    for (const p of live) {
      const q = p.snap.quotas && p.snap.quotas[name];
      if (!q || !quotaReset(q)) continue;
      const same = !quotaReset(best) || Math.abs(quotaReset(q) - quotaReset(best)) < 120e3;
      if (same && (!best || !quotaReset(best) || !best.at || (q.at || 0) > best.at)) {
        best = q;
        if (p.snap.burn && p.snap.burn[name]) bestBurn = p.snap.burn[name];
      } else if (same && !bestBurn && p.snap.burn && p.snap.burn[name]) {
        bestBurn = p.snap.burn[name];
      }
    }
    if (!quotaReset(best)) {
      for (const p of withSnap) {
        if (liveSet.has(p)) continue;
        const q = p.snap.quotas && p.snap.quotas[name];
        const reset = quotaReset(q);
        if (!q || !reset || reset <= now) continue;
        if (!best || !quotaReset(best) || (q.at || 0) > (best.at || 0)) {
          best = q;
          if (p.snap.burn && p.snap.burn[name]) bestBurn = p.snap.burn[name];
        }
      }
    }
    if (best !== undefined) out.quotas[name] = best;
    if (bestBurn) outBurn[name] = bestBurn;
  }
  if (local.burn !== undefined || Object.keys(outBurn).length) out.burn = outBurn;
  return out;
}

module.exports = { mergeSnapshots };
