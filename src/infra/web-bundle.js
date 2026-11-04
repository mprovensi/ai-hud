// O app dos aparelhos (web/) sem etapa de build: uma única versão por conteúdo para HTML, JS, CSS e
// service worker. O app.js e o app.css entregues são os pedaços de web/js/ e web/css/ juntados na ordem
// abaixo. Os pedaços de JS são trechos do corpo de uma única função (compartilham as variáveis) e
// continuam em ES5 para rodar no Safari 9 do iPad mini 1.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_SCRIPTS = [
  'core/base',
  'home/quotas', 'home/sessions',
  'drawers/burn', 'drawers/usage',
  'app/alerts',
  'home/ollama', 'home/render',
  'drawers/detail', 'drawers/reply', 'drawers/overlays',
  'app/network', 'app/main',
];
const APP_STYLES = ['base', 'home/panels', 'home/cards', 'drawers/detail', 'home/gauges', 'drawers/overlay', 'screens/ipad', 'screens/mobile'];

// Endereços públicos dos ícones (manifest, apple-touch-icon) → arquivo em web/icons/
const ICONS = ['icon-76.png', 'icon-120.png', 'icon-152.png', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
const iconFile = (directory, name) => path.join(directory, 'icons', name);

function bundleScripts(directory) {
  const parts = APP_SCRIPTS.map((name) => fs.readFileSync(path.join(directory, 'js', `${name}.js`), 'utf8'));
  return `(function () {\n${parts.join('')}})();\n`;
}

function bundleStyles(directory) {
  return APP_STYLES.map((name) => fs.readFileSync(path.join(directory, 'css', `${name}.css`), 'utf8')).join('');
}

function createWebAssets(directory) {
  const sources = {
    'index.html': fs.readFileSync(path.join(directory, 'index.html')),
    'sw.js': fs.readFileSync(path.join(directory, 'sw.js')),
    'manifest.json': fs.readFileSync(path.join(directory, 'manifest.json')),
    'icon-192.png': fs.readFileSync(iconFile(directory, 'icon-192.png')),
    'icon-512.png': fs.readFileSync(iconFile(directory, 'icon-512.png')),
    'app.js': Buffer.from(bundleScripts(directory)),
    'app.css': Buffer.from(bundleStyles(directory)),
  };
  const hash = crypto.createHash('sha256');
  for (const name of Object.keys(sources)) hash.update(name).update('\0').update(sources[name]).update('\0');
  const version = hash.digest('hex').slice(0, 16);
  const shell = ['/', `/app.css?v=${version}`, `/app.js?v=${version}`, '/manifest.json', '/icon-192.png', '/icon-512.png'];
  const expand = (source) => source.toString('utf8').replace(/__HUD_VERSION__/g, version);
  const assets = {
    '/app.js': expand(sources['app.js']),
    '/app.css': sources['app.css'],
    '/manifest.json': sources['manifest.json'],
    '/icon-192.png': sources['icon-192.png'],
    '/icon-512.png': sources['icon-512.png'],
    '/sw.js': expand(sources['sw.js']).replace('__HUD_SHELL__', JSON.stringify(shell)),
  };
  const html = expand(sources['index.html']).replace(/(\/app\.(?:css|js))(?:\?v=[^"']*)?(?=["'])/g, `$1?v=${version}`);
  return { version, html, assets, shell };
}

module.exports = { createWebAssets, bundleScripts, bundleStyles, iconFile, APP_SCRIPTS, APP_STYLES, ICONS };
