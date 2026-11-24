// Tabela de preços equivalentes em API (USD por 1M de tokens) e cálculo de custo estimado (camada core: sem I/O).
// Em planos de assinatura fixa (Pro/Max/Plus), o valor representa o equivalente em API consumido.

const DEFAULT_RATES = [
  // Claude (Anthropic)
  { match: /opus[-._ ]?(4[-._ ]?[5-9]|[5-9])/i, input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: /opus/i, input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: /sonnet/i, input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: /haiku[-._ ]?3[-._ ]?5/i, input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  { match: /haiku/i, input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },

  // OpenAI / Codex
  { match: /(gpt-5|codex).*mini|o4-mini|gpt-4o-mini/i, input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0.25 },
  { match: /gpt-5\.?([2-9])|codex/i, input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  { match: /gpt-5/i, input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  { match: /\bo3\b|gpt-4\.1/i, input: 2.0, output: 8.0, cacheRead: 0.5, cacheWrite: 2.0 },

  // Gemini (Google)
  { match: /flash[-._ ]?lite/i, input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
  { match: /gemini.*flash/i, input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0.15 },
  { match: /gemini.*pro|gemini/i, input: 1.25, output: 10.0, cacheRead: 0.31, cacheWrite: 1.25 },
];

const TOOL_FALLBACK_RATES = {
  'Claude Code': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  Codex: { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  Gemini: { input: 1.25, output: 10.0, cacheRead: 0.31, cacheWrite: 1.25 },
  Antigravity: { input: 1.25, output: 10.0, cacheRead: 0.31, cacheWrite: 1.25 },
  Ollama: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function rateForModel(model, tool = '', overrides = null) {
  const m = String(model || '').trim();
  if (overrides && typeof overrides === 'object') {
    for (const [key, val] of Object.entries(overrides)) {
      if (m && m.toLowerCase().includes(key.toLowerCase()) && val && typeof val === 'object') {
        return {
          input: Number(val.input) || 0,
          output: Number(val.output) || 0,
          cacheRead: Number(val.cacheRead) || 0,
          cacheWrite: Number(val.cacheWrite) || 0,
        };
      }
    }
  }
  if (m) {
    for (const r of DEFAULT_RATES) {
      if (r.match.test(m)) return { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite };
    }
  }
  return TOOL_FALLBACK_RATES[tool] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function primaryModel(session) {
  if (!session) return '';
  if (typeof session.model === 'string' && session.model) return session.model;
  const list = session.models instanceof Set ? [...session.models] : Array.isArray(session.models) ? session.models : [];
  // Preferir último modelo usado na sessão (mais representativo após /model)
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && typeof list[i] === 'string') return list[i];
  }
  return '';
}

function calcTokensCostUsd({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }, rate) {
  const r = rate || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const usd =
    (Math.max(0, Number(input) || 0) * r.input +
      Math.max(0, Number(output) || 0) * r.output +
      Math.max(0, Number(cacheRead) || 0) * r.cacheRead +
      Math.max(0, Number(cacheWrite) || 0) * r.cacheWrite) /
    1_000_000;
  return Number.isFinite(usd) ? usd : 0;
}

function estimateSessionCostUsd(session, overrides = null) {
  if (!session) return { usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: '' };
  const model = primaryModel(session);
  const rate = rateForModel(model, session.tool, overrides);
  const input = Math.max(0, Number(session.input) || 0);
  const output = Math.max(0, Number(session.output) || 0);
  const cacheRead = Math.max(0, Number(session.cacheRead) || 0);
  const cacheWrite = Math.max(0, Number(session.cacheWrite) || 0);
  if (input + output + cacheRead + cacheWrite > 0) {
    return {
      usd: calcTokensCostUsd({ input, output, cacheRead, cacheWrite }, rate),
      input,
      output,
      cacheRead,
      cacheWrite,
      model,
    };
  }
  // Fallback quando apenas events[] sintéticos existem
  let evFresh = 0;
  let evCache = 0;
  for (const e of session.events || []) {
    evFresh += Math.max(0, Number(e.fresh) || 0);
    evCache += Math.max(0, Number(e.cacheRead) || 0);
  }
  const estIn = Math.round(evFresh * 0.7);
  const estOut = evFresh - estIn;
  return {
    usd: calcTokensCostUsd({ input: estIn, output: estOut, cacheRead: evCache, cacheWrite: 0 }, rate),
    input: estIn,
    output: estOut,
    cacheRead: evCache,
    cacheWrite: 0,
    model,
  };
}

function roundUsd(v) {
  return Math.round((Number(v) || 0) * 10000) / 10000;
}

function emptyBucket() {
  return { usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptyToolCosts() {
  return {
    'Claude Code': emptyBucket(),
    Codex: emptyBucket(),
    Gemini: emptyBucket(),
  };
}

function canonicalCostTool(tool) {
  if (tool === 'Claude Code' || tool === 'Codex' || tool === 'Gemini') return tool;
  if (tool === 'Antigravity') return 'Gemini';
  return '';
}

function summarizeCosts(sessions, now, overrides = null) {
  const today = emptyToolCosts();
  const week = emptyToolCosts();
  const month = emptyToolCosts();

  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const todayStart = midnight.getTime();
  const weekStart = todayStart - 6 * 86400e3;
  const monthStart = todayStart - 29 * 86400e3;

  const addShare = (bucket, est, share) => {
    bucket.usd += est.usd * share;
    bucket.input += Math.round(est.input * share);
    bucket.output += Math.round(est.output * share);
    bucket.cacheRead += Math.round(est.cacheRead * share);
    bucket.cacheWrite += Math.round(est.cacheWrite * share);
  };

  for (const s of sessions || []) {
    const tool = canonicalCostTool(s.tool);
    if (!tool) continue;
    const est = estimateSessionCostUsd(s, overrides);
    if (est.usd <= 0 && est.input + est.output + est.cacheRead + est.cacheWrite <= 0) continue;

    const events = Array.isArray(s.events) ? s.events : [];
    if (events.length > 0) {
      let totalW = 0;
      let wToday = 0;
      let wWeek = 0;
      let wMonth = 0;
      for (const e of events) {
        const t = Date.parse(e.ts);
        if (!Number.isFinite(t)) continue;
        const w = Math.max(0, Number(e.fresh) || 0) + Math.max(0, Number(e.cacheRead) || 0) * 0.1;
        if (w <= 0) continue;
        totalW += w;
        if (t >= todayStart) wToday += w;
        if (t >= weekStart) wWeek += w;
        if (t >= monthStart) wMonth += w;
      }
      if (totalW > 0) {
        if (wToday > 0) addShare(today[tool], est, wToday / totalW);
        if (wWeek > 0) addShare(week[tool], est, wWeek / totalW);
        if (wMonth > 0) addShare(month[tool], est, wMonth / totalW);
        continue;
      }
    }

    const endTs = Date.parse(s.end);
    if (Number.isFinite(endTs)) {
      if (endTs >= todayStart) addShare(today[tool], est, 1);
      if (endTs >= weekStart) addShare(week[tool], est, 1);
      if (endTs >= monthStart) addShare(month[tool], est, 1);
    }
  }

  for (const group of [today, week, month]) {
    for (const k of Object.keys(group)) {
      group[k].usd = roundUsd(group[k].usd);
    }
  }
  return { today, week, month };
}

module.exports = {
  DEFAULT_RATES,
  TOOL_FALLBACK_RATES,
  rateForModel,
  primaryModel,
  calcTokensCostUsd,
  estimateSessionCostUsd,
  summarizeCosts,
};
