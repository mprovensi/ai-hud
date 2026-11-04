// Tokens por hora nas últimas 24h, por dia nos últimos 7 dias e de hoje (inclui subagentes: é uso real).
// Dias e horas pela meia-noite local deste PC.
function usage(all, now) {
  const hourMs = 3600e3;
  const firstHour = Math.floor(now / hourMs) * hourMs - 23 * hourMs;
  const hours = Array.from({ length: 24 }, (_, i) => ({ t: firstHour + i * hourMs, 'Claude Code': 0, Codex: 0 }));
  const today = { 'Claude Code': { fresh: 0, cacheRead: 0 }, Codex: { fresh: 0, cacheRead: 0 } };
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(midnight); d.setDate(d.getDate() - 6 + i);
    return { t: d.getTime(), 'Claude Code': 0, Codex: 0 };
  });
  const sessionsToday = { 'Claude Code': 0, Codex: 0, Antigravity: 0, Ollama: 0 };
  for (const s of all) {
    if (!s.subagent && Date.parse(s.end) >= midnight.getTime()) sessionsToday[s.tool]++;
    for (const e of s.events) {
      const t = Date.parse(e.ts);
      const i = Math.floor((t - firstHour) / hourMs);
      if (i >= 0 && i < 24) hours[i][s.tool] += e.fresh;
      if (t >= midnight.getTime()) { today[s.tool].fresh += e.fresh; today[s.tool].cacheRead += e.cacheRead; }
      for (let d = days.length - 1; d >= 0; d--) if (t >= days[d].t) { days[d][s.tool] += e.fresh; break; }
    }
  }
  return { hours, days, today, sessionsToday };
}

module.exports = { usage };
