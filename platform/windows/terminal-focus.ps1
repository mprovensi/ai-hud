[CmdletBinding()]
param(
  [ValidateSet('Inspect', 'Select', 'Window')][string]$Mode = 'Inspect',
  [int]$ClientProcessId = 0,
  [string]$SessionFile = '',
  [string]$ExpectedProcess = 'claude|codex|ollama',
  [string]$ExpectedStart = '',
  [long]$SessionStartMs = 0,
  [long]$WindowHandle = 0,
  [string]$TitleHintsJson = '[]',
  [string]$TitleHintsBase64 = '',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class HudTerminalNative {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint Id; public System.Runtime.InteropServices.ComTypes.FILETIME Start; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string ServiceName;
    public int AppType; public uint Status; public uint SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint session, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint session, uint count, string[] files, uint apps, IntPtr processes, uint services, IntPtr names);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[] info, ref uint reason);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint processId);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetConsoleTitle(StringBuilder text, uint length);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int number);
  [DllImport("kernel32.dll")] static extern bool SetStdHandle(int number, IntPtr handle);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public static uint[] FileUsers(string file) {
    uint session; int error = RmStartSession(out session, 0, new StringBuilder(33));
    if (error != 0) throw new Win32Exception(error);
    try {
      error = RmRegisterResources(session, 1, new string[] {file}, 0, IntPtr.Zero, 0, IntPtr.Zero);
      if (error != 0) throw new Win32Exception(error);
      uint count=0, needed=0, reason=0;
      error = RmGetList(session, out needed, ref count, null, ref reason);
      if (error == 0) return new uint[0];
      if (error != 234) throw new Win32Exception(error);
      var info = new ProcessInfo[needed]; count=needed;
      error = RmGetList(session, out needed, ref count, info, ref reason);
      if (error != 0) throw new Win32Exception(error);
      var ids = new uint[count];
      for (int i=0; i<count; i++) ids[i]=info[i].Process.Id;
      return ids;
    } finally { RmEndSession(session); }
  }
  public static long ConsoleWindow(uint processId) {
    var input=GetStdHandle(-10); var output=GetStdHandle(-11); var error=GetStdHandle(-12);
    try {
      FreeConsole();
      if (!AttachConsole(processId)) return 0;
      var h = GetConsoleWindow();
      return IsWindowVisible(h) ? h.ToInt64() : 0;
    } finally {
      FreeConsole(); SetStdHandle(-10,input); SetStdHandle(-11,output); SetStdHandle(-12,error);
    }
  }
  public static string ConsoleTitle(uint processId) {
    var input=GetStdHandle(-10); var output=GetStdHandle(-11); var error=GetStdHandle(-12);
    try {
      FreeConsole();
      if (!AttachConsole(processId)) return "";
      var text = new StringBuilder(1024); GetConsoleTitle(text, 1024);
      return text.ToString();
    } finally {
      FreeConsole(); SetStdHandle(-10,input); SetStdHandle(-11,output); SetStdHandle(-12,error);
    }
  }
}
'@

try {
  if ($Mode -eq 'Inspect') {
    $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine, ExecutablePath)
    $client = $null
    if ($ClientProcessId -gt 0) {
      $client = $rows | Where-Object { $_.ProcessId -eq $ClientProcessId -and $_.Name -match "^($ExpectedProcess)(\.exe)?$" } | Select-Object -First 1
      if ($client -and $ExpectedStart -match '^\d+$') {
        $actualStart = $client.CreationDate.ToUniversalTime().ToFileTimeUtc()
        if ([Math]::Abs($actualStart - [long]$ExpectedStart) -gt 10000000) { $client = $null }
      }
    } elseif ($SessionFile -and (Test-Path -LiteralPath $SessionFile -PathType Leaf)) {
      $owners = @([HudTerminalNative]::FileUsers($SessionFile))
      $ownerMatches = @($rows | Where-Object { $owners -contains $_.ProcessId -and $_.Name -match "^($ExpectedProcess)(\.exe)?$" })
      if ($ownerMatches.Count -eq 1) { $client = $ownerMatches[0] }
      # Codex atual: quem grava o arquivo é o app-server compartilhado (sem janela); o CLI no terminal
      # é outro codex.exe, cliente dele. Acha o CLI pelo horário de início da sessão (ou por ser o único).
      if ($ExpectedProcess -eq 'codex' -and (-not $client -or "$($client.CommandLine)" -match '\bapp-server\b')) {
        $client = $null
        # Fora: o app-server, o Codex da extensão do VS Code e o do app (WindowsApps)
        $tuis = @($rows | Where-Object { $_.Name -eq 'codex.exe' -and "$($_.CommandLine)" -notmatch '\bapp-server\b' -and
          "$($_.ExecutablePath)" -notmatch '\\\.vscode[^\\]*\\extensions\\|\\WindowsApps\\|\\app-server-daemon\\' })
        if ($SessionStartMs -gt 0) {
          $start = [DateTimeOffset]::FromUnixTimeMilliseconds($SessionStartMs).UtcDateTime
          # O CLI abre um pouco antes da sessão (até 2 min antes, nunca mais de 10 s depois)
          $near = @($tuis | Where-Object { $d = ($start - $_.CreationDate.ToUniversalTime()).TotalSeconds; $d -ge -10 -and $d -le 120 } |
            Sort-Object { [Math]::Abs(($start - $_.CreationDate.ToUniversalTime()).TotalSeconds) })
          if ($near.Count) { $client = $near[0] }
        }
        if (-not $client -and $tuis.Count -eq 1) { $client = $tuis[0] }
      }
    }
    $ancestors = @()
    $current = $client
    $visited = @{}
    while ($current -and -not $visited.ContainsKey([string]$current.ProcessId)) {
      $visited[[string]$current.ProcessId] = $true
      $ancestors += @{ pid = [int]$current.ProcessId; name = $current.Name }
      $child = $current
      $current = $rows | Where-Object { $_.ProcessId -eq $child.ParentProcessId } | Select-Object -First 1
      if ($current -and $current.CreationDate -gt $child.CreationDate) { break }
    }
    $title = if ($client) { [HudTerminalNative]::ConsoleTitle([uint32]$client.ProcessId) } else { '' }
    $consoleWindow = if ($client) { [HudTerminalNative]::ConsoleWindow([uint32]$client.ProcessId) } else { 0 }
    @{ ok = $true; clientPid = $(if ($client) { [int]$client.ProcessId } else { 0 }); ancestors = @($ancestors); consoleTitle = $title; consoleWindow = $consoleWindow } | ConvertTo-Json -Compress -Depth 5
    exit 0
  }

  if ($Mode -eq 'Window') {
    $handle = [IntPtr]$WindowHandle
    if ($WindowHandle -eq 0 -or -not [HudTerminalNative]::IsWindowVisible($handle)) { @{ ok = $false; message = 'A janela do terminal não está mais aberta.' } | ConvertTo-Json -Compress; exit 0 }
    if ($DryRun) { @{ ok = $true; dryRun = $true } | ConvertTo-Json -Compress; exit 0 }
    if ([HudTerminalNative]::IsIconic($handle)) { [void][HudTerminalNative]::ShowWindow($handle, 9) }
    [HudTerminalNative]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [HudTerminalNative]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][HudTerminalNative]::SetForegroundWindow($handle)
    @{ ok = $true } | ConvertTo-Json -Compress
    exit 0
  }

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  if ($TitleHintsBase64) { $TitleHintsJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleHintsBase64)) }
  $parsedHints = ConvertFrom-Json $TitleHintsJson
  $hints = @($parsedHints | ForEach-Object { $_ } | Where-Object { $_ -and "$_".Trim().Length -ge 3 })
  $hints = @($hints | Where-Object { $_ -notmatch '^(Windows PowerShell|PowerShell( 7)?( \(x64\))?|pwsh|cmd|Terminal|Codex|Claude( Code)?)$' })
  $terminalIds = @(Get-Process -Name WindowsTerminal, WindowsTerminalPreview -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  $windows = New-Object System.Collections.ArrayList
  [HudTerminalNative]::EnumWindows({ param($handle, $data)
    if ([HudTerminalNative]::IsWindowVisible($handle)) {
      $owner = [uint32]0
      [void][HudTerminalNative]::GetWindowThreadProcessId($handle, [ref]$owner)
      if ($terminalIds -contains $owner) { [void]$windows.Add($handle) }
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  $candidates = @()
  $condition = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::TabItem)
  foreach ($handle in $windows) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    foreach ($tab in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
      $name = $tab.Current.Name
      $score = 0
      for ($hintIndex = 0; $hintIndex -lt $hints.Count; $hintIndex++) {
        if ($name.IndexOf($hints[$hintIndex], [StringComparison]::OrdinalIgnoreCase) -ge 0) {
          $value = 10000 - $hintIndex * 10
          if ($name.Equals($hints[$hintIndex], [StringComparison]::OrdinalIgnoreCase)) { $value += 2 }
          $score = [Math]::Max($score, $value)
        }
      }
      if ($score -gt 0) { $candidates += @{ tab = $tab; handle = $handle; name = $name; score = $score } }
    }
  }
  if (-not $candidates.Count) { @{ ok = $false; code = 'not_found'; message = 'Não identifiquei a aba. Use um título único com o nome da sessão, projeto ou modelo.' } | ConvertTo-Json -Compress; exit 0 }
  $bestScore = ($candidates | ForEach-Object { $_.score } | Measure-Object -Maximum).Maximum
  $best = @($candidates | Where-Object { $_.score -eq $bestScore })
  if ($best.Count -ne 1) { @{ ok = $false; code = 'ambiguous'; message = 'Há várias abas com o mesmo título. Dê um nome único à aba para identificá-la.' } | ConvertTo-Json -Compress; exit 0 }
  $selected = $best[0]
  if ($DryRun) { @{ ok = $true; dryRun = $true; tab = $selected.name } | ConvertTo-Json -Compress; exit 0 }
  if ([HudTerminalNative]::IsIconic($selected.handle)) { [void][HudTerminalNative]::ShowWindow($selected.handle, 9) }
  $pattern = $selected.tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $pattern.Select()
  if (-not $pattern.Current.IsSelected) { throw 'O terminal não confirmou a seleção da aba.' }
  [HudTerminalNative]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [HudTerminalNative]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][HudTerminalNative]::SetForegroundWindow($selected.handle)
  $selected.tab.SetFocus()
  @{ ok = $true; tab = $selected.name } | ConvertTo-Json -Compress
} catch {
  Write-Verbose $_.Exception.Message
  Write-Verbose $_.FullyQualifiedErrorId
  @{ ok = $false; code = 'unavailable'; message = 'Não foi possível identificar ou selecionar a aba do terminal.' } | ConvertTo-Json -Compress
  exit 1
}
