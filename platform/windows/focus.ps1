# Traz para frente a janela de uma sessão (VS Code ou terminal), a pedido do botão "Abrir no PC" do HUD.
#   -Process  nomes de processo separados por "|" (ex.: Code, WindowsTerminal)
#   -Include  trechos de título, em ordem de preferência, separados por "|"; vazio = qualquer janela
#   -Exclude  trechos que o título não pode ter, separados por "|"
#   -DryRun   só informa qual janela seria escolhida
param([string]$Process, [string]$Include = '', [string]$Exclude = '', [switch]$DryRun, [switch]$Unique)

Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class HudWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}
"@

$pids = @(Get-Process -Name ($Process -split '\|') -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
$windows = New-Object System.Collections.ArrayList
[HudWin]::EnumWindows({
  param($h, $l)
  if ([HudWin]::IsWindowVisible($h)) {
    $p = [uint32]0
    [void][HudWin]::GetWindowThreadProcessId($h, [ref]$p)
    if ($pids -contains $p) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][HudWin]::GetWindowText($h, $sb, 512)
      if ($sb.Length -gt 0) { [void]$windows.Add(@{ h = $h; t = $sb.ToString() }) }
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null

$excl = @($Exclude -split '\|' | Where-Object { $_ })
$candidates = @($windows | Where-Object { $t = $_.t; -not ($excl | Where-Object { $t.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) })
$found = $null
foreach ($want in @($Include -split '\|')) {
  $matching = @($candidates | Where-Object { -not $want -or $_.t.IndexOf($want, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  if ($Unique -and $matching.Count -gt 1) { continue }
  $found = $matching | Select-Object -First 1
  if ($found) { break }
}
if (-not $found) { Write-Output 'none'; exit 1 }
if ($DryRun) { Write-Output "found $($found.t)"; exit 0 }

if ([HudWin]::IsIconic($found.h)) { [void][HudWin]::ShowWindow($found.h, 9) } # SW_RESTORE
# O Windows não deixa um processo em segundo plano tomar o foco; um toque de Alt libera SetForegroundWindow
[HudWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[HudWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][HudWin]::SetForegroundWindow($found.h)
Write-Output "ok $($found.t)"
