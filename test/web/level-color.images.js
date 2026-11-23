// Gera imagens das cores da cota (barra e anel de contexto) a partir do levelColor do próprio app.js.
//   npm run imagens   → test-output/imagens/*.png
// Fica fora do `npm test` (abre um navegador sem janela). Para comparar outras faixas de cor, acrescente
// em VARIANTS: cada uma troca só LEVEL_STOPS, então a regra de mistura é sempre a do app.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = require('../helpers/app-source');
const { OUT, findBrowser, screenshot } = require('../helpers/screenshot');

const POINTS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 100];

// Faixas de cor para comparar com a atual: [% da cota, 'ok' | 'warn' | 'crit']
const VARIANTS = [
  { name: 'B · Anterior', about: 'do azul em 0% direto ao vermelho em 80%',
    stops: [[0, 'ok'], [80, 'crit']] },
];

function loadLevelColor() {
  const context = {};
  vm.runInNewContext(app.match(/var STATUS = [\s\S]*?function levelColor[\s\S]*?return out;\s*\}/)[0], context);
  return context;
}

function panel(title, about, color) {
  let strip = '';
  for (let p = 0; p <= 100; p++) strip += `<span style="background:${color(p)}"></span>`;
  const rows = POINTS.map((p) => `<div class="r"><span class="p">${p}%</span>` +
    `<div class="tr"><div style="width:${p}%;background:${color(p)}"></div></div>` +
    `<svg viewBox="0 0 36 36" width="30" height="30"><circle cx="18" cy="18" r="15.9" fill="none" stroke="#2c2c29" stroke-width="4"/>` +
    `<circle cx="18" cy="18" r="15.9" fill="none" stroke="${color(p)}" stroke-width="4" stroke-dasharray="${p} 100" pathLength="100" transform="rotate(-90 18 18)"/></svg>` +
    `<code>${color(p)}</code></div>`).join('');
  return `<div class="pn"><h2>${title}</h2><div class="d">${about}</div><div class="st">${strip}</div>` +
    `<div class="ax"><span>início</span><span>meio</span><span>fim</span></div>${rows}</div>`;
}

function page(panels, width) {
  return '<!doctype html><meta charset="utf-8"><style>' +
    `body{margin:0;background:#121211;color:#ecece8;font:14px system-ui,sans-serif;padding:16px;display:flex;gap:12px;width:${width}px}` +
    '.pn{flex:1;background:#1c1c1a;border:1px solid #2c2c29;border-radius:14px;padding:14px}h2{font-size:15px;margin:0 0 4px}' +
    '.d{color:#8d8d87;font-size:12px;min-height:32px}.r{display:flex;align-items:center;gap:8px;margin:6px 0}' +
    '.p{width:38px;text-align:right;font-weight:700;font-size:13px}.tr{flex:1;height:10px;background:#2c2c29;border-radius:5px;overflow:hidden}' +
    '.tr div{height:100%;border-radius:5px}code{color:#8d8d87;font-size:10px;width:54px}' +
    '.st{display:flex;height:20px;border-radius:6px;overflow:hidden;margin:8px 0 3px}.st span{flex:1}' +
    '.ax{display:flex;justify-content:space-between;color:#8d8d87;font-size:11px;margin-bottom:10px}</style>' + panels.join('');
}

async function shoot(browser, name, html, width) {
  const file = path.join(OUT, name + '.html');
  fs.writeFileSync(file, html);
  await screenshot(browser, 'file:///' + file.replace(/\\/g, '/'), name, { width: width + 32, height: width > 1000 ? 640 : 560 });
}

test('imagens das cores da cota: a do app e as alternativas lado a lado', async (t) => {
  const browser = findBrowser();
  if (!browser) return t.skip('nenhum navegador Edge/Chrome/Chromium encontrado');
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = loadLevelColor();
  const current = panel('A · Atual (no app)', ctx.LEVEL_STOPS.map((s) => `${s[0]}% ${s[1]}`).join(' → '), ctx.levelColor);
  await shoot(browser, 'cota-atual', page([current], 420), 420);

  const variants = VARIANTS.map((v) => {
    const c = loadLevelColor();
    c.LEVEL_STOPS = v.stops.map(([p, k]) => [p, c.STATUS[k]]);
    return panel(v.name, v.about, c.levelColor);
  });
  await shoot(browser, 'cota-comparacao', page([current, ...variants], 720), 720);
});

// ---- Acessibilidade: a escala atual e a recomendada vistas por quem não distingue vermelho e verde ----
// Simulação de Viénot, Brettel & Mollon (1999) em RGB linear; "cinza" usa a luminância (preto e branco)
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const gam = (c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
const VISION = {
  normal: null,
  protanopia: [[0.11238, 0.88762, 0], [0.11238, 0.88762, 0], [0.00401, -0.00401, 1]],
  deuteranopia: [[0.29275, 0.70725, 0], [0.29275, 0.70725, 0], [-0.02234, 0.02234, 1]],
  'preto e branco': [[0.2126, 0.7152, 0.0722], [0.2126, 0.7152, 0.0722], [0.2126, 0.7152, 0.0722]],
};
function simulate(hex, m) {
  if (!m) return hex;
  const n = parseInt(hex.slice(1), 16), rgb = [lin(n >> 16), lin((n >> 8) & 255), lin(n & 255)];
  return '#' + m.map((row) => gam(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]).toString(16).padStart(2, '0')).join('');
}

const SCALES = [
  { name: 'Atual', about: 'azul e vermelho com a mesma luminosidade', colors: null },
  { name: 'Recomendada', about: 'a luminosidade sobe com o risco: azul fechado → vermelho claro e vivo',
    colors: { ok: '#3f5f95', crit: '#ff4b4b' } },
];

test('imagem de acessibilidade: escala atual × recomendada, com simulação de daltonismo', async (t) => {
  const browser = findBrowser();
  if (!browser) return t.skip('nenhum navegador Edge/Chrome/Chromium encontrado');
  fs.mkdirSync(OUT, { recursive: true });
  const points = [0, 30, 50, 60, 70, 80, 100];
  let rows = '';
  for (const scale of SCALES) {
    const c = loadLevelColor();
    if (scale.colors) {
      Object.assign(c.STATUS, scale.colors);
      c.LEVEL_STOPS = c.LEVEL_STOPS.map(([p, col]) => [p, col === loadLevelColor().STATUS.ok ? c.STATUS.ok : c.STATUS.crit]);
    }
    let cells = '';
    for (const [vision, m] of Object.entries(VISION)) {
      const color = (p) => simulate(c.levelColor(p), m);
      let strip = '';
      for (let p = 0; p <= 100; p++) strip += `<span style="background:${color(p)}"></span>`;
      const bars = points.map((p) => `<div class="r"><span class="p">${p}%</span><div class="tr"><div style="width:${Math.max(p, 2)}%;` +
        `background:${color(p)}"></div></div></div>`).join('');
      cells += `<div class="cell"><div class="v">${vision}</div><div class="st">${strip}</div>${bars}</div>`;
    }
    rows += `<div class="pn"><h2>${scale.name}</h2><div class="d">${scale.about} · ${c.STATUS.ok} → ${c.STATUS.crit}</div><div class="cells">${cells}</div></div>`;
  }
  const html = '<!doctype html><meta charset="utf-8"><style>' +
    'body{margin:0;background:#121211;color:#ecece8;font:14px system-ui,sans-serif;padding:16px;width:1100px}' +
    '.pn{background:#1c1c1a;border:1px solid #2c2c29;border-radius:14px;padding:14px;margin-bottom:12px}h2{font-size:16px;margin:0 0 2px}' +
    '.d{color:#8d8d87;font-size:12px;margin-bottom:10px}.cells{display:flex;gap:14px}.cell{flex:1}.v{font-size:12px;color:#b5b5ae;margin-bottom:4px}' +
    '.st{display:flex;height:16px;border-radius:5px;overflow:hidden;margin-bottom:8px}.st span{flex:1}' +
    '.r{display:flex;align-items:center;gap:6px;margin:5px 0}.p{width:34px;text-align:right;font-size:12px;font-weight:700}' +
    '.tr{flex:1;height:10px;background:#2c2c29;border-radius:5px;overflow:hidden}.tr div{height:100%;border-radius:5px}</style>' + rows;
  await shoot(browser, 'cota-acessibilidade', html, 1100);
});
