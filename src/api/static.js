// Arquivos do PWA e ícones: não têm segredo e o navegador os busca sem cookie (antes do login).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { iconFile } = require('../infra/web-bundle');

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

const CLAUDE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#e08a66" stroke-width="2.1" stroke-linecap="round"><path d="M12 2.5v19M2.5 12h19M5.3 5.3l13.4 13.4M18.7 5.3L5.3 18.7M8.3 3.2l7.4 17.6M20.8 8.3L3.2 15.7M15.7 3.2L8.3 20.8M20.8 15.7L3.2 8.3"/></svg>';
const CODEX_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#5fb8a4" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5a4.5 4.5 0 0 1 4.2 2.9 4.5 4.5 0 0 1 5.3 4.4 4.5 4.5 0 0 1-1.3 6.1 4.5 4.5 0 0 1-4.9 5.3 4.5 4.5 0 0 1-6.6 0 4.5 4.5 0 0 1-4.9-5.3 4.5 4.5 0 0 1-1.3-6.1 4.5 4.5 0 0 1 5.3-4.4A4.5 4.5 0 0 1 12 2.5z"/></svg>';
const GEMINI_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#7d9bf0"><path d="M12 2C12.7 7.2 16.8 11.3 22 12c-5.2.7-9.3 4.8-10 10-.7-5.2-4.8-9.3-10-10 5.2-.7 9.3-4.8 10-10z"/></svg>';
// Fallback da lhama do Ollama em preto/transparente (o CSS .ollama-ico aplica o filtro lilás igual ao app.ico)
const OLLAMA_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10V5.2C8 3.6 9.6 3.2 10.3 4.6L11.2 6.8C11.7 6.7 12.3 6.7 12.8 6.8L13.7 4.6C14.4 3.2 16 3.6 16 5.2V10C17.8 11 18.6 12.8 18.2 15C17.8 17.5 16.4 19.6 15.8 21H8.2C7.6 19.6 6.2 17.5 5.8 15C5.4 12.8 6.2 11 8 10Z"/><circle cx="9.8" cy="12.6" r="1" fill="#000" stroke="none"/><circle cx="14.2" cy="12.6" r="1" fill="#000" stroke="none"/><path d="M10.8 15.2C11.4 15.9 12.6 15.9 13.2 15.2M12 14.3V15.5"/></svg>';

// Ícones salvos localmente em data/brands/ (ex.: copiados de um PC com VS Code para uma VPS Linux)
function savedBrand(dataDir, name, asUtf8 = true) {
  if (!dataDir) return null;
  try { return fs.readFileSync(path.join(dataDir, 'brands', name), asUtf8 ? 'utf8' : undefined); } catch { return null; }
}

// Devolve um handler (res, url) => true se respondeu
function createStatic({ webDir, webAssets, send, brands = true, dataDir }) {
  const ollama = brands ? (ollamaIcon() || savedBrand(dataDir, 'brand-ollama.png', false)) : null;
  const svgs = brands ? {
    '/brand-claude.svg': extensionIcon('anthropic.claude-code-', 'claude-logo.svg', '#e08a66') || savedBrand(dataDir, 'brand-claude.svg') || CLAUDE_SVG,
    '/brand-codex.svg': extensionIcon('openai.chatgpt-', 'blossom-white.svg', '#5fb8a4') || savedBrand(dataDir, 'brand-codex.svg') || CODEX_SVG,
    '/brand-gemini.svg': GEMINI_SVG,
  } : {
    '/brand-claude.svg': CLAUDE_SVG,
    '/brand-codex.svg': CODEX_SVG,
    '/brand-gemini.svg': GEMINI_SVG,
  };
  const day = { 'Cache-Control': 'max-age=86400' };

  return function serveStatic(res, url) {
    const p = url.pathname;
    if (p === '/brand-ollama.png') {
      if (ollama) send(res, 200, 'image/png', ollama, day);
      else send(res, 200, 'image/svg+xml', OLLAMA_SVG, day);
      return true;
    }
    if (svgs[p]) { send(res, 200, 'image/svg+xml', svgs[p], day); return true; }
    // O iOS também procura o ícone nesses endereços fixos, mesmo sem <link> na página
    if (p === '/apple-touch-icon.png' || p === '/apple-touch-icon-precomposed.png' || p === '/favicon.ico') {
      send(res, 200, 'image/png', fs.readFileSync(iconFile(webDir, 'icon-180.png')));
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
    send(res, 200, type, webAssets.assets[p] || fs.readFileSync(iconFile(webDir, p.slice(1))), headers);
    return true;
  };
}

module.exports = { createStatic };
