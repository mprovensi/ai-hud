// Uma única versão por conteúdo para HTML, JS, CSS e service worker, sem etapa de build.
// O app.js e o app.css entregues aos aparelhos são os pedaços de public/js/ e public/css/ juntados
// na ordem abaixo. Os pedaços de JS são trechos do corpo de uma única função (compartilham as
// variáveis); continuam em ES5 para rodar no Safari 9 do iPad mini 1.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_SCRIPTS = ['core', 'quotas', 'sessions', 'burn', 'usage', 'alerts', 'ollama', 'render', 'detail', 'reply', 'overlays', 'network', 'main'];
const APP_STYLES = ['base', 'panels', 'cards', 'detail', 'gauges', 'overlay', 'ipad', 'mobile'];

function bundleScripts(directory) {
  const parts = APP_SCRIPTS.map((name) => fs.readFileSync(path.join(directory, 'js', `${name}.js`), 'utf8'));
  return `(function () {\n${parts.join('')}})();\n`;
}

function bundleStyles(directory) {
  return APP_STYLES.map((name) => fs.readFileSync(path.join(directory, 'css', `${name}.css`), 'utf8')).join('');
}

function createWebAssets(directory) {
  const names = ['index.html', 'sw.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
  const sources = Object.fromEntries(names.map((name) => [name, fs.readFileSync(path.join(directory, name))]));
  sources['app.js'] = Buffer.from(bundleScripts(directory));
  sources['app.css'] = Buffer.from(bundleStyles(directory));
  const hash = crypto.createHash('sha256');
  for (const name of [...names, 'app.js', 'app.css']) hash.update(name).update('\0').update(sources[name]).update('\0');
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

module.exports = { createWebAssets, bundleScripts, bundleStyles, APP_SCRIPTS, APP_STYLES };
