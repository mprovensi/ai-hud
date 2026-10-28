// Uma única versão por conteúdo para HTML, JS, CSS e service worker, sem etapa de build.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createWebAssets(directory) {
  const names = ['index.html', 'app.js', 'app.css', 'sw.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
  const sources = Object.fromEntries(names.map((name) => [name, fs.readFileSync(path.join(directory, name))]));
  const hash = crypto.createHash('sha256');
  for (const name of names) hash.update(name).update('\0').update(sources[name]).update('\0');
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

module.exports = { createWebAssets };
