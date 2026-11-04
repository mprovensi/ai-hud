// Abrir no PC, parte 2: executa. Foca a janela da sessão (platform/windows/focus.ps1) e, no VS Code, abre a
// aba da sessão pelo link da extensão. O link vai para a última janela ativa: só é enviado depois de focar
// a janela certa. Sessões no terminal usam terminal.js (Windows Terminal, console ou terminal do VS Code).
const path = require('path');
const { execFile } = require('child_process');
const { ROOT } = require('../../infra/paths');
const { createTerminalFocus } = require('./terminal');
const { focusPlan, winPath, noPipe, base } = require('./plan');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function createFocus({ terminal = createTerminalFocus(), platform = process.platform, exec = execFile } = {}) {
  const focusWindow = (plan) => new Promise((resolve) => exec('powershell', ['-NoProfile', '-File', path.join(ROOT, 'platform', 'windows', 'focus.ps1'), '-Process', plan.process,
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

module.exports = { createFocus };
