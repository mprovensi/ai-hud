// Arquivos do PWA e ícones: não têm segredo e o navegador os busca sem cookie (antes do login).
const fs = require('fs');
const os = require('os');
const path = require('path');

// Ícones oficiais que as extensões do VS Code já trazem, pintados nas cores do HUD (só para esta rede)
function extensionIcon(prefix, file, color) {
  const dir = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const latest = fs.readdirSync(dir).filter((d) => d.startsWith(prefix))
      .map((d) => ({ d, t: fs.statSync(path.join(dir, d)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    const svg = fs.readFileSync(path.join(dir, latest.d, 'resources', file), 'utf8');
    return svg.replace(/fill="(?!none)[^"]*"/g, `fill="${color}"`);
  } catch { return null; }
}

// Ícone do Ollama: o PNG de 256px dentro do app.ico do app instalado (Windows); null se não houver
function ollamaIcon() {
  try {
    const ico = fs.readFileSync(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'app.ico'));
    let best = null;
    for (let i = 0; i < ico.readUInt16LE(4); i++) {
      const e = 6 + i * 16, w = ico[e] || 256, size = ico.readUInt32LE(e + 8), off = ico.readUInt32LE(e + 12);
      const png = ico.slice(off, off + size);
      if (png.slice(0, 4).toString('hex') === '89504e47' && (!best || w > best.w)) best = { w, png };
    }
    return best && best.png;
  } catch { return null; }
}

const PUBLIC_ASSETS = {
  '/manifest.json': 'application/manifest+json', '/sw.js': 'text/javascript; charset=utf-8',
  '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/icon-180.png': 'image/png',
  '/icon-152.png': 'image/png', '/icon-120.png': 'image/png', '/icon-76.png': 'image/png',
  '/app.css': 'text/css; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8',
};

// Devolve um handler (res, url) => true se respondeu
function createStatic({ publicDir, webAssets, send, brands = true }) {
  const ollama = brands ? ollamaIcon() : null;
  const svgs = brands ? {
    '/brand-claude.svg': extensionIcon('anthropic.claude-code-', 'claude-logo.svg', '#e08a66'),
    '/brand-codex.svg': extensionIcon('openai.chatgpt-', 'blossom-white.svg', '#5fb8a4'),
  } : {};
  const day = { 'Cache-Control': 'max-age=86400' };

  return function serveStatic(res, url) {
    const p = url.pathname;
    if (p === '/brand-ollama.png') {
      if (ollama) send(res, 200, 'image/png', ollama, day); else send(res, 404, 'text/plain', '');
      return true;
    }
    if (svgs[p]) { send(res, 200, 'image/svg+xml', svgs[p], day); return true; }
    // O iOS também procura o ícone nesses endereços fixos, mesmo sem <link> na página
    if (p === '/apple-touch-icon.png' || p === '/apple-touch-icon-precomposed.png' || p === '/favicon.ico') {
      send(res, 200, 'image/png', fs.readFileSync(path.join(publicDir, 'icon-180.png')));
      return true;
    }
    const type = PUBLIC_ASSETS[p];
    if (!type) return false;
    const versioned = p === '/app.js' || p === '/app.css';
    const v = url.searchParams.get('v');
    if (versioned && url.searchParams.has('v') && v !== webAssets.version) {
      send(res, 409, 'text/plain; charset=utf-8', 'Versão antiga. Atualize a página do AI HUD.');
      return true;
    }
    const headers = p === '/sw.js' ? { 'Service-Worker-Allowed': '/' }
      : versioned && v === webAssets.version ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {};
    send(res, 200, type, webAssets.assets[p] || fs.readFileSync(path.join(publicDir, p)), headers);
    return true;
  };
}

module.exports = { createStatic };
