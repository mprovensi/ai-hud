// Gera hud.html (nesta pasta) com sessões e tokens de todos os CLIs e abre no navegador
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { claudeSessions, codexData, antigravitySessions, day } = require('./lib');

const DAYS = Number(process.argv[2]) || 14;
const codex = codexData();
const all = [...claudeSessions(), ...codex.sessions, ...antigravitySessions()]
  .filter((s) => !s.subagent)
  .sort((a, b) => (a.end < b.end ? 1 : -1));

const TOOLS = ['Claude Code', 'Codex', 'Antigravity'];
const tokens = (s) => s.input + s.output + s.cacheRead + s.cacheWrite;
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n));
const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const days = [];
for (let i = DAYS - 1; i >= 0; i--) days.push(day(Date.now() - i * 864e5));
const since = days[0];
const recent = all.filter((s) => day(s.end) >= since);
const today = day(Date.now());

const totals = TOOLS.map((t) => {
  const ss = recent.filter((s) => s.tool === t);
  return { tool: t, sessions: ss.length, today: ss.filter((s) => day(s.end) === today).length,
    tokens: ss.reduce((a, s) => a + tokens(s), 0), output: ss.reduce((a, s) => a + s.output, 0),
    prompts: ss.reduce((a, s) => a + (s.prompts || 0), 0) };
});

// Tokens por dia (atribuídos ao dia em que a sessão terminou)
const perDay = days.map((d) => {
  const row = { d };
  for (const t of TOOLS) row[t] = recent.filter((s) => s.tool === t && day(s.end) === d).reduce((a, s) => a + tokens(s), 0);
  return row;
});
const maxDay = Math.max(1, ...perDay.map((r) => TOOLS.reduce((a, t) => a + r[t], 0)));

const limitBar = (label, used, resetsAt) => {
  const reset = resetsAt ? new Date(resetsAt * 1000).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const lvl = used >= 80 ? 'hi' : used >= 50 ? 'mid' : 'lo';
  return `<div class="lim"><span>${label}</span><div class="track"><div class="fill ${lvl}" style="width:${used}%"></div></div><b>${Math.round(used)}%</b><small>reset ${reset}</small></div>`;
};
const L = codex.limits;
const limitsHtml = L && L.primary
  ? limitBar('Codex · janela 5h', L.primary.used_percent, L.primary.resets_at) +
    (L.secondary ? limitBar('Codex · semanal', L.secondary.used_percent, L.secondary.resets_at) : '') +
    `<p class="note">Plano ${esc(L.plan_type || '')} · leitura de ${new Date(codex.limitsTs).toLocaleString('pt-BR')}${L.primary.resets_at * 1000 < Date.now() ? ' (janela 5h já resetou)' : ''}</p>`
  : '<p class="note">Sem dados de limite do Codex.</p>';

// Claude: limites só chegam via stdin da statusline, que grava a última leitura em last-statusline.json
let claudeLimitsHtml = '<p class="note">Sem leitura ainda: abra uma sessão do <code>claude</code> no terminal e mande uma mensagem.</p>';
try {
  const sl = JSON.parse(fs.readFileSync(path.join(__dirname, 'last-statusline.json'), 'utf8'));
  const rl = sl.rate_limits || {};
  const live = (w) => w && w.used_percentage != null && w.resets_at * 1000 > Date.now();
  const parts = [];
  if (live(rl.five_hour)) parts.push(limitBar('Claude · janela 5h', rl.five_hour.used_percentage, rl.five_hour.resets_at));
  if (live(rl.seven_day)) parts.push(limitBar('Claude · semanal', rl.seven_day.used_percentage, rl.seven_day.resets_at));
  if (parts.length) claudeLimitsHtml = parts.join('') + `<p class="note">Leitura de ${new Date(sl.at).toLocaleString('pt-BR')} (atualiza a cada resposta no Claude Code)</p>`;
} catch {}

const bars = perDay.map((r) => {
  const segs = TOOLS.map((t) => r[t] ? `<div class="seg t${TOOLS.indexOf(t)}" style="height:${(r[t] / maxDay) * 100}%" title="${t}: ${k(r[t])}"></div>` : '').join('');
  const tot = TOOLS.reduce((a, t) => a + r[t], 0);
  return `<div class="col"><div class="stack" title="${r.d}: ${k(tot)}">${segs}</div><small>${r.d.slice(8)}</small></div>`;
}).join('');

const rows = recent.slice(0, 60).map((s) => `<tr>
  <td><span class="dot t${TOOLS.indexOf(s.tool)}"></span>${s.tool}</td>
  <td>${new Date(s.end).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
  <td class="path" title="${esc(s.cwd)}">${esc(path.basename(s.cwd || '') || '—')}</td>
  <td>${esc([...s.models].join(', ') || '—')}</td>
  <td class="n">${s.tool === 'Antigravity' ? `${s.prompts} prompts` : k(tokens(s))}</td>
  <td class="n">${s.tool === 'Antigravity' ? '—' : k(s.output)}</td></tr>`).join('');

const cards = totals.map((t, i) => `<div class="card"><div class="h"><span class="dot t${i}"></span>${t.tool}</div>
  <div class="big">${t.sessions}<small> sessões</small></div>
  <div class="sub">${t.today} hoje · ${t.tool === 'Antigravity' ? `${t.prompts} prompts (sem tokens no log)` : `${k(t.tokens)} tokens · ${k(t.output)} saída`}</div></div>`).join('');

const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI HUD</title><style>
:root{--bg:#f6f6f4;--panel:#fff;--fg:#1d1d1b;--mut:#6b6b66;--line:#e3e3df;--c0:#c96442;--c1:#2f7d6d;--c2:#4a6fd1;--lo:#2f7d6d;--mid:#c9962f;--hi:#c94242}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--panel:#1f1f1d;--fg:#ecece8;--mut:#9a9a94;--line:#33332f;--c0:#e08a66;--c1:#5fb8a4;--c2:#7d9bf0;--lo:#5fb8a4;--mid:#e0b45a;--hi:#e87070}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;padding:24px 16px}
main{max-width:1100px;margin:auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;color:var(--mut);font-weight:600;margin:28px 0 10px;text-transform:uppercase;letter-spacing:.04em}
.note{color:var(--mut);font-size:12px;margin:6px 0 0}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}.h{font-weight:600}.big{font-size:30px;font-weight:700;margin-top:6px}
.big small{font-size:13px;color:var(--mut);font-weight:400}.sub{color:var(--mut);font-size:12px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px}
.t0{background:var(--c0)}.t1{background:var(--c1)}.t2{background:var(--c2)}
.chart{display:flex;gap:4px;align-items:flex-end;height:180px}.col{flex:1;display:flex;flex-direction:column;align-items:center;height:100%}
.stack{flex:1;width:100%;display:flex;flex-direction:column-reverse;gap:1px}.seg{width:100%;border-radius:2px}.col small{color:var(--mut);font-size:11px;margin-top:4px}
.lim{display:grid;grid-template-columns:150px 1fr 48px auto;gap:10px;align-items:center;margin:6px 0}.track{height:10px;background:var(--line);border-radius:5px;overflow:hidden}
.fill{height:100%}.fill.lo{background:var(--lo)}.fill.mid{background:var(--mid)}.fill.hi{background:var(--hi)}.lim small{color:var(--mut)}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--mut);font-weight:600}.n{text-align:right;font-variant-numeric:tabular-nums}.path{max-width:220px;overflow:hidden;text-overflow:ellipsis}
@media (max-width:600px){.lim{grid-template-columns:1fr 48px}.lim .track{grid-column:1/-1;order:3}.lim small{display:none}}
</style></head><body><main>
<h1>AI HUD</h1><p class="note">Últimos ${DAYS} dias · gerado em ${new Date().toLocaleString('pt-BR')} · tokens incluem cache (leitura+escrita) · subagentes excluídos</p>
<h2>Resumo</h2><div class="cards">${cards}</div>
<h2>Limites do plano</h2><div class="panel">${claudeLimitsHtml}</div><div class="panel" style="margin-top:12px">${limitsHtml}</div>
<h2>Tokens por dia</h2><div class="panel"><div class="chart">${bars}</div></div>
<h2>Sessões recentes</h2><div class="panel tw"><table><tr><th>CLI</th><th>Última atividade</th><th>Projeto</th><th>Modelo</th><th class="n">Tokens</th><th class="n">Saída</th></tr>${rows}</table></div>
</main></body></html>`;

const out = path.join(__dirname, 'hud.html');
fs.writeFileSync(out, html);
console.log(out);
if (!process.argv.includes('--no-open')) {
  try { execSync(`start "" "${out}"`, { shell: 'cmd.exe', stdio: 'ignore' }); } catch {}
}
