const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('tray HTTPS handles CLI timeouts, login, routing conflicts and verified activation',
  { skip: process.platform !== 'win32', timeout: 30000 }, () => {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'tray-tailscale-checks.ps1')], { encoding: 'utf8', timeout: 25000, windowsHide: true });
    assert.equal(result.status, 0, [result.error, result.stdout, result.stderr].filter(Boolean).join('\n'));
    assert.match(result.stdout, /Tailscale tray checks passed/);
  });
