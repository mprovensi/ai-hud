// Print de uma página com o navegador sem janela (Edge/Chrome no Windows, Chromium no Linux), para os
// geradores de imagem (test/web/*.images.js). Pasta de saída: test-output/imagens (fora do git).
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const OUT = path.join(__dirname, '..', '..', 'test-output', 'imagens');

function findBrowser() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Salva <OUT>/<name>.png. O print sai quando a página termina de carregar (o app já desenha com os dados).
// Sem --virtual-time-budget: com ele o navegador espera o long-polling do app e o print nunca sai. Assíncrono: o servidor
// do HUD pode estar no mesmo processo e precisa responder ao navegador enquanto isso.
async function screenshot(browser, url, name, { width, height }) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name + '.png');
  fs.rmSync(file, { force: true });
  // Perfil próprio por imagem: sem ele o Edge entrega o pedido à janela já aberta e sai antes de salvar
  await new Promise((resolve) => execFile(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
    `--user-data-dir=${path.join(OUT, '.perfil-' + name)}`, `--window-size=${width},${height}`, `--screenshot=${file}`, url], { timeout: 60e3 }, () => resolve()));
  // O Edge pode sair antes de gravar o arquivo
  for (let i = 0; i < 100 && !(fs.existsSync(file) && fs.statSync(file).size > 1000); i++) await new Promise((r) => setTimeout(r, 200));
  if (!(fs.existsSync(file) && fs.statSync(file).size > 1000)) throw new Error(`${name}.png não foi gerado`);
  console.log('imagem:', file);
  return file;
}

module.exports = { OUT, findBrowser, screenshot };
