# Detecta interação local do usuário na janela da IDE Antigravity usando apenas APIs padrão
# de janela ativa e tempo de ociosidade do Windows (GetForegroundWindow + GetLastInputInfo).
# Não captura nem lê teclas; apenas informa "LOCAL_INPUT" quando o usuário interage na janela.
param(
  [string]$ProcessName = 'Antigravity',
  [int]$GraceMs = 2000,
  [int]$PollMs = 250
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class IdeInputWatch {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

  public static uint LastInput() {
    var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
    return GetLastInputInfo(ref info) ? info.dwTime : 0;
  }
  public static uint ForegroundPid() {
    var h = GetForegroundWindow();
    if (h == IntPtr.Zero) return 0;
    uint pid = 0;
    GetWindowThreadProcessId(h, out pid);
    return pid;
  }
}
"@

if ($GraceMs -gt 0) { Start-Sleep -Milliseconds $GraceMs }
$baseTime = [IdeInputWatch]::LastInput()
if ($baseTime -eq 0) { exit 0 }

$pidCache = @{}
while ($true) {
  Start-Sleep -Milliseconds $PollMs
  $cur = [IdeInputWatch]::LastInput()
  if ($cur -eq $baseTime) { continue }
  $baseTime = $cur
  $fgPid = [IdeInputWatch]::ForegroundPid()
  if ($fgPid -eq 0) { continue }
  if (-not $pidCache.ContainsKey($fgPid)) {
    $p = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
    $pidCache[$fgPid] = if ($p) { $p.ProcessName } else { '' }
  }
  if ($pidCache[$fgPid] -ieq $ProcessName) {
    Write-Output 'LOCAL_INPUT'
    exit 0
  }
}
