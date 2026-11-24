// Seletor nativo de pastas do sistema operacional (Windows Explorer moderno, macOS osascript, Linux zenity/kdialog).
// Zero dependências externas. Camada actions/.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function pickWindowsFolder(initialDir, exec) {
  return new Promise((resolve) => {
    // OpenFileDialog com ValidateNames=false abre o Explorer moderno do Windows 10/11
    // e o Form TopMost garante que o diálogo apareça sempre na frente do navegador.
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[System.Windows.Forms.Application]::EnableVisualStyles()',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true',
      '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
      '$owner.Width = 1; $owner.Height = 1; $owner.Opacity = 0; $owner.ShowInTaskbar = $false',
      '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
      '$dlg.Title = "Selecionar pasta do projeto"',
      '$dlg.ValidateNames = $false',
      '$dlg.CheckFileExists = $false',
      '$dlg.CheckPathExists = $true',
      '$dlg.FileName = "Selecionar esta pasta"',
      'if ($env:AI_HUD_INIT_DIR -and (Test-Path $env:AI_HUD_INIT_DIR)) { $dlg.InitialDirectory = $env:AI_HUD_INIT_DIR }',
      '$res = $dlg.ShowDialog($owner)',
      '$owner.Dispose()',
      'if ($res -eq [System.Windows.Forms.DialogResult]::OK) {',
      '  $dir = [System.IO.Path]::GetDirectoryName($dlg.FileName)',
      '  if ($dir) { [Console]::Out.Write($dir) }',
      '}',
    ].join('; ');

    exec('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      timeout: 120000,
      windowsHide: true,
      env: { ...process.env, AI_HUD_INIT_DIR: initialDir || '' },
    }, (err, stdout, stderr) => {
      if (err) {
        return resolve({ status: 500, body: (stderr || err.message || 'Falha ao abrir seletor de pastas.').trim() });
      }
      const picked = String(stdout || '').trim();
      resolve({ status: 200, body: { ok: true, path: picked, canceled: !picked } });
    });
  });
}

function pickMacFolder(initialDir, exec) {
  return new Promise((resolve) => {
    const loc = initialDir && fs.existsSync(initialDir) ? ` default location POSIX file ${JSON.stringify(initialDir)}` : '';
    exec('osascript', ['-e', `POSIX path of (choose folder with prompt "Selecionar pasta"${loc})`], { timeout: 120000 }, (err, stdout) => {
      if (err) return resolve({ status: 200, body: { ok: true, path: '', canceled: true } });
      const picked = String(stdout || '').trim().replace(/\/+$/, '') || '/';
      resolve({ status: 200, body: { ok: true, path: picked, canceled: !picked } });
    });
  });
}

function pickLinuxFolder(initialDir, exec) {
  return new Promise((resolve) => {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return resolve({ status: 400, body: 'Esta máquina não possui interface gráfica (ex.: VPS headless).' });
    }
    const args = ['--file-selection', '--directory', '--title=Selecionar pasta'];
    if (initialDir && fs.existsSync(initialDir)) args.push(`--filename=${initialDir.replace(/\/?$/, '/')}`);
    exec('zenity', args, { timeout: 120000 }, (err, stdout) => {
      if (!err) {
        const picked = String(stdout || '').trim();
        return resolve({ status: 200, body: { ok: true, path: picked, canceled: !picked } });
      }
      if (err.code === 1) return resolve({ status: 200, body: { ok: true, path: '', canceled: true } });
      // Fallback para kdialog (KDE)
      exec('kdialog', ['--getexistingdirectory', initialDir || process.env.HOME || '/'], { timeout: 120000 }, (kErr, kOut) => {
        if (!kErr) {
          const picked = String(kOut || '').trim();
          return resolve({ status: 200, body: { ok: true, path: picked, canceled: !picked } });
        }
        if (kErr.code === 1) return resolve({ status: 200, body: { ok: true, path: '', canceled: true } });
        resolve({ status: 400, body: 'Nenhum seletor nativo (zenity/kdialog) instalado nesta máquina.' });
      });
    });
  });
}

function createFolderPicker({ platform = process.platform, exec = execFile } = {}) {
  return async function pickFolder({ initialDir = '' } = {}) {
    const cleanInit = String(initialDir || '').trim();
    const resolvedInit = cleanInit && fs.existsSync(cleanInit) ? path.resolve(cleanInit) : '';
    if (platform === 'win32') return pickWindowsFolder(resolvedInit, exec);
    if (platform === 'darwin') return pickMacFolder(resolvedInit, exec);
    return pickLinuxFolder(resolvedInit, exec);
  };
}

module.exports = { createFolderPicker };
