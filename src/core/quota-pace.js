// Ritmo das cotas (como CodexBar/ccburn): compara o uso com o tempo já passado da janela e projeta o reset.
// A taxa vem das leituras da última hora; sem amostras suficientes, da média desde o início da janela.
// history: { "<ia>.<janela>": { resetsAt, samples: [[ms, %], ...] } }

const WINDOW_MS = { five_hour: 5 * 3600e3, seven_day: 7 * 86400e3 };

function pace(history, name, key, w, now) {
  const dur = WINDOW_MS[key];
  if (!w || !dur || !w.resetsAt) return null;
  const left = Math.max(0, w.resetsAt - now);
  const elapsed = Math.min(1, Math.max(0, 1 - left / dur));
  const samples = ((history[`${name}.${key}`] || {}).samples || []).filter((s) => now - s[0] <= 3600e3);
  let rate = null, basis = 'average'; // % por ms
  if (key === 'five_hour' && samples.length >= 2 && samples[samples.length - 1][0] - samples[0][0] >= 15 * 60e3) {
    const [t0, u0] = samples[0], [t1, u1] = samples[samples.length - 1];
    rate = Math.max(0, (u1 - u0) / (t1 - t0));
    basis = 'recent';
  } else if (elapsed > 0.1) { // antes disso uma única chamada grande distorce a projeção
    rate = w.used / (elapsed * dur);
  }
  const projected = rate == null ? null : Math.round(w.used + rate * left);
  const runsOutIn = rate > 0 && w.used < 100 && projected >= 100 ? Math.round((100 - w.used) / rate) : null;
  return { expected: Math.round(elapsed * 100), projected, runsOutIn, basis };
}

// Burn-up da janela de 5h: % usado ao longo da janela, para o gráfico com projeção até o reset.
// O Codex grava a cota a cada chamada (limitSamples): histórico gratuito para o desenho.
function burn(quotas, history, now, codexSessions) {
  const out = {};
  for (const name of ['claude', 'codex']) {
    const w = quotas[name] && quotas[name].windows && quotas[name].windows.five_hour;
    if (!w || !w.resetsAt) continue;
    const start = w.resetsAt - WINDOW_MS.five_hour;
    let points = ((history[`${name}.five_hour`] || {}).samples || []).filter((s) => s[0] >= start);
    if (name === 'codex') {
      for (const s of codexSessions) {
        for (const [t, used, resetsAt] of s.limitSamples || []) {
          if (t >= start && Math.abs(resetsAt - w.resetsAt) < 60e3) points.push([t, used]);
        }
      }
    }
    points = [[start, 0], ...points].sort((a, b) => a[0] - b[0]);
    // Uma amostra por ~3 min basta para o desenho
    const thin = [];
    for (const p of points) if (!thin.length || p[0] - thin[thin.length - 1][0] >= 180e3) thin.push(p);
    thin.push([Math.min(now, w.resetsAt), w.used]);
    const p = pace(history, name, 'five_hour', w, now);
    out[name] = { start, end: w.resetsAt, used: w.used, points: thin, projected: p && p.projected, runsOutIn: p && p.runsOutIn };
  }
  return out;
}

// Cotas com o ritmo de cada janela, como os aparelhos recebem
function quotasWithPace(quotas, history, now) {
  const out = {};
  for (const [name, q] of Object.entries(quotas)) {
    if (!q) { out[name] = null; continue; }
    const windows = {};
    for (const [key, w] of Object.entries(q.windows || {})) windows[key] = w && { ...w, pace: pace(history, name, key, w, now) };
    out[name] = { ...q, windows };
  }
  return out;
}

// Alguma janela já virou? (relê na hora em vez de esperar o próximo ciclo)
const expired = (quotas, now) => Object.values(quotas).some((q) => q && Object.values(q.windows || {}).some((w) => w && w.resetsAt < now));

module.exports = { pace, burn, quotasWithPace, expired, WINDOW_MS };
