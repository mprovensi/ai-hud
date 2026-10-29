// Abrir no PC: foca a janela da sessão (focus.ps1) e, no VS Code, abre a aba da sessão pelo link da
// extensão. O link vai para a última janela ativa: só é enviado depois de focar a janela certa.
// Sessões no terminal usam terminal.js (Windows Terminal, console ou terminal do VS Code).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ROOT } = require('../paths');
const { replyKey } = require('../actions/replies');
const { createTerminalFocus } = require('./terminal');

const VSCODE_STORAGE = path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'storage.json');
const base = (p) => (p ? p.split(/[\\/]/).filter(Boolean).pop() : '');
// O Codex às vezes grava o cwd como caminho longo do Windows (\\?\D:\... ou \\?\UNC\servidor\...)
const winPath = (p) => String(p || '').replace(/\//g, '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
  .replace(/\\+$/, '').toLowerCase();
const noPipe = (t) => String(t || '').replace(/\|/g, ' ');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

function createFocus({ terminal = createTerminalFocus(), platform = process.platform, exec = execFile } = {}) {
  const focusWindow = (plan) => new Promise((resolve) => exec('powershell', ['-NoProfile', '-File', path.join(ROOT, 'windows', 'focus.ps1'), '-Process', plan.process,
    '-Include', plan.include, '-Exclude', plan.exclude, ...(plan.unique ? ['-Unique'] : [])], { windowsHide: true, timeout: 20e3 },
  (err, out) => resolve(String(out || '').trim().startsWith('ok'))));
  const openUri = (uri) => new Promise((resolve) => exec('explorer.exe', [uri], { windowsHide: true }, () => resolve()));

  return async function focusSession(s) {
    // Trazer janelas para frente usa PowerShell/Win32 (focus.ps1): só no Windows por enquanto
    if (platform !== 'win32') return { ok: false, message: 'Abrir no PC ainda só funciona em PCs com Windows.' };
    if (s.where === 'terminal' || s.where === 'ollama-run') {
      const result = await terminal(s);
      if (result.ok && result.host === 'vscode') {
        const folders = result.folders || [];
        const folder = folders.find((f) => winPath(s.cwd) === winPath(f) || winPath(s.cwd).startsWith(winPath(f) + '\\')) || folders[0];
        const names = [...new Set([result.workspaceName, base(folder)].filter(Boolean))];
        const include = names.map((name) => noPipe(`${name} - Visual Studio Code`)).concat('Visual Studio Code').join('|');
        const focused = await focusWindow({ process: 'Code', include, exclude: '', unique: true });
        if (!focused) return { ok: false, message: 'Aba selecionada, mas não identifiquei uma janela única do VS Code para trazê-la à frente.' };
      }
      return { ok: result.ok, message: result.message };
    }
    const plan = focusPlan(s);
    if (!plan) {
      return { ok: false, message: s.where === 'claude-desktop' ? 'Essa sessão não está mais no app do Claude.'
        : 'Abrir no PC funciona para sessões no VS Code, no terminal ou nos apps do Claude, do Codex e do Ollama.' };
    }
    // Apps: o link abre a conversa (e o app, se fechado); depois só garante a janela na frente
    if (plan.uriFirst) {
      await openUri(plan.uri);
      await wait(800);
      await focusWindow(plan);
      return { ok: true, message: plan.label };
    }
    if (!(await focusWindow(plan))) return { ok: false, message: `Nenhuma janela aberta no PC para ${base(s.cwd) || 'esta sessão'}.` };
    if (!plan.uri) return { ok: true, message: plan.label || 'Janela em primeiro plano.' };
    // VS Code: o link vai para a última janela ativa; dá tempo de registrar o foco antes
    await wait(500);
    await openUri(plan.uri);
    return { ok: true, message: 'Sessão aberta no VS Code.' };
  };
}

module.exports = { createFocus, focusPlan, winPath };
