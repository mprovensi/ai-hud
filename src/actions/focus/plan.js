// Abrir no PC, parte 1: qual janela trazer à frente e qual link abrir para cada sessão. Só decide; quem
// executa é index.js. Lê o estado de janelas do VS Code e as sessões do app do Claude.
const fs = require('fs');
const path = require('path');
const { replyKey } = require('../reply/claude-queue');
const { base } = require('../../core/session');

const VSCODE_STORAGE = path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'storage.json');
// O Codex às vezes grava o cwd como caminho longo do Windows (\\?\D:\... ou \\?\UNC\servidor\...)
const winPath = (p) => String(p || '').replace(/\//g, '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
  .replace(/\\+$/, '').toLowerCase();
const noPipe = (t) => String(t || '').replace(/\|/g, ' ');

function vscodeFolders() {
  try {
    const w = JSON.parse(fs.readFileSync(VSCODE_STORAGE, 'utf8')).windowsState || {};
    return [w.lastActiveWindow, ...(w.openedWindows || [])]
      .filter((x) => x && x.folder && x.folder.startsWith('file:///'))
      .map((x) => winPath(decodeURIComponent(x.folder.slice(8))));
  } catch { return []; }
}

// App do Claude: cada sessão tem um local_<uuid>.json cujo cliSessionId é o id do log
function claudeDesktopId(cliId) {
  const root = path.join(process.env.APPDATA || '', 'Claude', 'claude-code-sessions');
  try {
    for (const org of fs.readdirSync(root)) {
      for (const acct of fs.readdirSync(path.join(root, org))) {
        const dir = path.join(root, org, acct);
        for (const f of fs.readdirSync(dir)) {
          if (!/^local_[0-9a-f-]{36}\.json$/.test(f)) continue;
          try {
            const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (m.cliSessionId === cliId && !m.isArchived) return m.sessionId;
          } catch {}
        }
      }
    }
  } catch {}
  return null;
}

function focusPlan(s, folders = vscodeFolders()) {
  const key = replyKey(s);
  // App do Ollama: o link ollama:// só abre o app (não uma conversa); depois traz a janela para frente
  if (s.where === 'ollama-app') return { uriFirst: true, uri: 'ollama://', process: 'ollama app', include: '', exclude: '', label: 'App do Ollama aberto: escolha a conversa nele.' };
  // App do Codex (ChatGPT.exe): o link abre a conversa pelo id da thread; depois traz a janela para frente
  if (s.where === 'codex-desktop') return { uriFirst: true, uri: `codex://threads/${key}`, process: 'ChatGPT', include: '', exclude: '', label: 'Conversa aberta no app do Codex.' };
  if (s.where === 'claude-desktop') {
    const local = claudeDesktopId(s.id);
    if (!local) return null;
    // O link abre a conversa no app; depois traz a janela do app para frente
    return { uriFirst: true, uri: `claude://claude.ai/epitaxy/${local}`, process: 'claude', include: 'Claude', exclude: '', label: 'Sessão aberta no app do Claude.' };
  }
  folders = [...new Set(folders)];
  const cwd = winPath(s.cwd);
  const own = folders.filter((f) => cwd === f || cwd.startsWith(f + '\\')).sort((a, b) => b.length - a.length)[0];
  const title = (f) => `${path.win32.basename(f)} - Visual Studio Code`;
  if (s.where === 'vscode') {
    return {
      process: 'Code',
      // Janela sem pasta (ex.: sessão na pasta do usuário): a do VS Code que não é de nenhuma pasta aberta
      include: own ? noPipe(title(own)) : 'Visual Studio Code',
      exclude: own ? '' : folders.map((f) => noPipe(title(f))).join('|'),
      uri: s.tool === 'Codex' ? `vscode://openai.chatgpt/local/${key}` : `vscode://anthropic.claude-code/open?session=${key}`,
    };
  }
  return null;
}

module.exports = { focusPlan, winPath, noPipe, base };
