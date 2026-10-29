// Statusline do Claude Code: modelo · contexto · tokens/custo da sessão · limites Claude e Codex
const { codexData } = require('../src/sources/codex');

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(raw); } catch {}
  // Guarda a última entrada para o dashboard (limites do Claude não ficam em nenhum log)
  try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'data', 'last-statusline.json'), JSON.stringify({ at: new Date().toISOString(), ...d }, null, 2)); } catch {}

  const c = { dim: '\x1b[2m', red: '\x1b[31m', yel: '\x1b[33m', grn: '\x1b[32m', cyn: '\x1b[36m', rst: '\x1b[0m' };
  const pctColor = (p) => (p >= 80 ? c.red : p >= 50 ? c.yel : c.grn);
  const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0));
  const pct = (p) => `${pctColor(p)}${Math.round(p)}%${c.rst}`;

  const parts = [`${c.cyn}${(d.model && d.model.display_name) || 'Claude'}${c.rst}`];

  const cw = d.context_window || {};
  if (cw.used_percentage != null) parts.push(`ctx ${pct(cw.used_percentage)}`);
  if (cw.total_input_tokens != null) parts.push(`↑${k(cw.total_input_tokens)} ↓${k(cw.total_output_tokens)}`);

  const cost = d.cost && d.cost.total_cost_usd;
  if (cost != null) parts.push(`${c.dim}$${cost.toFixed(2)}${c.rst}`);

  const rl = d.rate_limits || {};
  const claudeLim = [];
  if (rl.five_hour && rl.five_hour.used_percentage != null) claudeLim.push(`5h ${pct(rl.five_hour.used_percentage)}`);
  if (rl.seven_day && rl.seven_day.used_percentage != null) claudeLim.push(`7d ${pct(rl.seven_day.used_percentage)}`);
  if (claudeLim.length) parts.push(claudeLim.join(' '));

  // Codex: último rate_limits registrado (só mostra se a janela de 5h ainda não resetou)
  try {
    const { limits } = codexData();
    const p = limits && limits.primary;
    if (p && p.resets_at * 1000 > Date.now()) {
      const s = limits.secondary;
      parts.push(`${c.dim}Codex${c.rst} 5h ${pct(p.used_percent)}${s ? ` 7d ${pct(s.used_percent)}` : ''}`);
    }
  } catch {}

  process.stdout.write(parts.join(` ${c.dim}│${c.rst} `));
});
