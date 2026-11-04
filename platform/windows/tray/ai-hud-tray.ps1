# AI HUD na bandeja do Windows: inicia o servidor, mostra status e log, reinicia/para.
# Uso normal (sem janela de console): platform\windows\tray\start-tray.vbs
# Teste sem interface: powershell -File platform\windows\tray\ai-hud-tray.ps1 -Test -Port 8796 -Root <cópia do projeto>
param(
  [string]$Root = (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))),
  [int]$Port = $(if ($env:AI_HUD_PORT) { [int]$env:AI_HUD_PORT } else { 8787 }),
  [switch]$Test
)

$ErrorActionPreference = 'Stop'
$LogFile = Join-Path $Root 'data\server.log'
$OldLog = Join-Path $Root 'data\server.old.log'
$script:TailscaleHelper = Join-Path $PSScriptRoot 'tailscale-serve.ps1'
. $script:TailscaleHelper
$script:DiagnosticHelper = Join-Path $PSScriptRoot 'diagnostics.ps1'
. $script:DiagnosticHelper
$script:localJob = $null
$script:localJobPid = $null
$script:localState = $null
$script:localStatePid = $null
$script:lastLocalOk = $null
$script:lastHttpsOk = $null
$script:diagnosticEvents = @()
$script:diagnosticKeys = @{}
$script:eventFile = Join-Path $Root 'data\tray-events.json'
try { $script:diagnosticEvents = @(Get-Content -LiteralPath $script:eventFile -Raw -Encoding UTF8 | ConvertFrom-Json | Where-Object { $_ -and $_.Message } | Select-Object -First 20) } catch {}
function Add-HudDiagnostic([string]$Source, [string]$Message, [switch]$Repeat) {
  $message = Protect-HudDiagnosticText $Message (Get-Config)
  if (-not $Repeat -and $script:diagnosticKeys[$Source] -eq $message) { return }
  $script:diagnosticKeys[$Source] = $message
  $script:diagnosticEvents = @((@([pscustomobject]@{ At = (Get-Date).ToString('o'); Source = $Source; Message = $message }) + @($script:diagnosticEvents)) | Select-Object -First 20)
  try {
    $safe = Protect-HudDiagnosticText (ConvertTo-Json -InputObject @($script:diagnosticEvents) -Depth 4) (Get-Config)
    [System.IO.File]::WriteAllText($script:eventFile, $safe, [System.Text.Encoding]::UTF8)
  } catch {} # Falhar ao gravar diagnóstico não derruba a bandeja.
}

function Update-HudLocal {
  if ($script:localJob) {
    if ($script:localJob.State -eq 'Running') { return }
    try {
      $results = @(Receive-Job -Job $script:localJob -ErrorAction Stop)
      if (-not $results.Count) { throw 'A verificação local não retornou um resultado.' }
      $script:localState = $results[-1]
      $script:localStatePid = $script:localJobPid
      if ($script:localState.Ok) {
        $script:lastLocalOk = $script:localState.CheckedAt
        if ($script:diagnosticKeys['HTTP local']) { Add-HudDiagnostic 'HTTP local' 'Conexão recuperada.' }
      } else { Add-HudDiagnostic 'HTTP local' $script:localState.Error }
    } catch {
      $script:localState = [pscustomobject]@{ Ok = $false; Error = $_.Exception.Message; Machines = @(); Version = ''; CheckedAt = (Get-Date) }
      $script:localStatePid = $script:localJobPid
      Add-HudDiagnostic 'HTTP local' $_.Exception.Message
    }
    finally { Remove-Job -Job $script:localJob -Force; $script:localJob = $null }
  }
  if (-not $script:wantRunning) { return }
  $script:localJobPid = Get-ServerPid
  if (-not $script:localJobPid) { return }
  $cfg = Get-Config
  try {
    $script:localJob = Start-Job -ArgumentList $script:DiagnosticHelper, $Port, $cfg.token -ScriptBlock {
      param($helper, $hudPort, $token)
      $ErrorActionPreference = 'Stop'
      . $helper
      Get-HudLocalDiagnostic $hudPort $token
    }
  } catch {
    $script:localState = [pscustomobject]@{ Ok = $false; Error = $_.Exception.Message; Machines = @(); Version = ''; CheckedAt = (Get-Date) }
    $script:localStatePid = $script:localJobPid
    Add-HudDiagnostic 'HTTP local' $_.Exception.Message
  }
}
$script:httpsState = New-HudTailscaleState 'Checking' 'Verificando Tailscale...'
$script:httpsJob = $null
$script:httpsNext = [datetime]::MinValue

# O CLI pode aguardar rede ou autorização. Tudo roda em outro processo, sem travar a bandeja.
function Update-HudHttps([switch]$Force) {
  if ($script:httpsJob) {
    if ($script:httpsJob.State -eq 'Running') { return }
    try {
      $results = @(Receive-Job -Job $script:httpsJob -ErrorAction Stop)
      if (-not $results.Count -or -not $results[-1].State) { throw 'O Tailscale não retornou um estado válido.' }
      $script:httpsState = $results[-1]
      if ($script:httpsState.HttpsOk -eq $true) { $script:lastHttpsOk = $script:httpsState.CheckedAt }
    } catch { $script:httpsState = New-HudTailscaleState 'Error' $_.Exception.Message }
    finally { Remove-Job -Job $script:httpsJob -Force; $script:httpsJob = $null }
    if ($script:httpsState.State -ne 'Ready') { Add-HudDiagnostic 'Tailscale' $script:httpsState.Message }
    elseif ($script:httpsState.HttpsOk -eq $false) { Add-HudDiagnostic 'HTTPS' $script:httpsState.HttpsMessage }
    else {
      if ($script:diagnosticKeys['Tailscale']) { Add-HudDiagnostic 'Tailscale' 'Conexão recuperada.' }
      if ($script:diagnosticKeys['HTTPS']) { Add-HudDiagnostic 'HTTPS' 'Acesso recuperado.' }
    }
    $script:httpsNext = (Get-Date).AddSeconds(60)
  }
  if (-not $script:wantRunning -or (-not $Force -and (Get-Date) -lt $script:httpsNext)) { return }
  if (-not (Get-ServerPid)) { return }
  try {
    $script:httpsJob = Start-Job -ArgumentList $script:TailscaleHelper, $Port -ScriptBlock {
      param($helper, $hudPort)
      $ErrorActionPreference = 'Stop'
      . $helper
      Get-HudHttpsDiagnostic -Port $hudPort
    }
  } catch {
    $script:httpsState = New-HudTailscaleState 'Error' $_.Exception.Message
    $script:httpsNext = (Get-Date).AddSeconds(60)
  }
}

# ---- Servidor ---------------------------------------------------------------

# PID do processo que escuta na porta (o servidor pode ter sido iniciado por fora)
function Get-ServerPid {
  foreach ($line in (netstat -ano -p tcp)) {
    if ($line -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)") { return [int]$Matches[1] }
  }
  return $null
}

function Start-Server {
  if (Get-ServerPid) { return }
  # Guarda o log anterior e começa um novo
  if (Test-Path $LogFile) { Move-Item -Force $LogFile $OldLog -ErrorAction SilentlyContinue }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'cmd.exe'
  $psi.Arguments = "/c node server.js >> `"$LogFile`" 2>&1"
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['AI_HUD_PORT'] = "$Port"
  [void][System.Diagnostics.Process]::Start($psi)
  # Espera a porta abrir (até ~10 s)
  for ($i = 0; $i -lt 40 -and -not (Get-ServerPid); $i++) { Start-Sleep -Milliseconds 250 }
}

function Stop-Server {
  $id = Get-ServerPid
  if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 20 -and (Get-ServerPid); $i++) { Start-Sleep -Milliseconds 250 }
}

function Restart-Server { Stop-Server; Start-Server }

function Get-Config {
  try { return Get-Content -Raw -Encoding UTF8 (Join-Path $Root 'data\config.json') | ConvertFrom-Json } catch { return $null }
}

# Estado completo para a janela: processo, resposta HTTP, endereços, PIN e PCs do hub
function Get-Status {
  $s = [ordered]@{ Running = $false; Pid = $null; Since = $null; Http = $false; HttpPending = $false; HttpError = 'servidor parado'; Version = ''; Machines = @(); Pin = $null; Addresses = @() }
  $id = Get-ServerPid
  if ($id) {
    $s.Running = $true; $s.Pid = $id
    try { $s.Since = (Get-Process -Id $id).StartTime } catch {}
  }
  $cfg = Get-Config
  if ($cfg) { $s.Pin = $cfg.pin }
  if ($s.Running) {
    if ($Test) { $script:localState = Get-HudLocalDiagnostic $Port $cfg.token; $script:localStatePid = $id }
    $s.HttpPending = (-not $script:localState -or $script:localStatePid -ne $id)
    if (-not $s.HttpPending) {
      $s.Http = $script:localState.Ok
      $s.HttpError = $script:localState.Error
      $s.Machines = $script:localState.Machines
      $s.Version = $script:localState.Version
    }
  }
  $s.Addresses = @([System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
    Where-Object { $_.AddressFamily -eq 'InterNetwork' -and -not $_.IPAddressToString.StartsWith('127.') } |
    ForEach-Object { "http://$($_.IPAddressToString):$Port" })
  return [pscustomobject]$s
}

function Get-LogTail([int]$Lines = 300) {
  if (-not (Test-Path $LogFile)) { return '(sem log ainda)' }
  try {
    # Leitura compartilhada: o servidor continua escrevendo no arquivo
    $fs = New-Object System.IO.FileStream($LogFile, 'Open', 'Read', 'ReadWrite')
    $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
    $all = $sr.ReadToEnd(); $sr.Close()
    $rows = $all -split "`r?`n"
    return (($rows | Select-Object -Last $Lines) -join "`r`n")
  } catch { return "(não foi possível ler o log: $($_.Exception.Message))" }
}

function Format-Duration($since) {
  if (-not $since) { return '' }
  $d = (Get-Date) - $since
  if ($d.TotalHours -ge 24) { return '{0}d {1}h' -f [int][math]::Floor($d.TotalDays), $d.Hours }
  if ($d.TotalMinutes -ge 60) { return '{0}h{1:00}' -f [int][math]::Floor($d.TotalHours), $d.Minutes }
  return '{0}min' -f [int][math]::Floor($d.TotalMinutes)
}

# ---- Teste sem interface ----------------------------------------------------
if ($Test) {
  "porta $Port | raiz $Root"
  Start-Server; $st = Get-Status
  "iniciou: rodando=$($st.Running) pid=$($st.Pid) http=$($st.Http) maquinas=$($st.Machines -join ', ')"
  $old = $st.Pid; Restart-Server; $st = Get-Status
  "reiniciou: rodando=$($st.Running) pid novo=$($st.Pid -ne $old) http=$($st.Http)"
  Stop-Server; $st = Get-Status
  "parou: rodando=$($st.Running)"
  "log (últimas linhas):"; (Get-LogTail 3)
  exit 0
}

# ---- Interface (bandeja + janela de status) ---------------------------------
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# Uma única bandeja por usuário
$mutex = New-Object System.Threading.Mutex($false, 'Local\AIHUDTray')
if (-not $mutex.WaitOne(0)) { exit 0 }

# Ícone do HUD (colorido = rodando, cinza = parado)
function New-TrayIcon([bool]$gray) {
  $src = New-Object System.Drawing.Bitmap (Join-Path $Root 'web\icons\icon-192.png')
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'
  $attr = New-Object System.Drawing.Imaging.ImageAttributes
  if ($gray) {
    $m = New-Object System.Drawing.Imaging.ColorMatrix(, [single[][]]@(
        [single[]]@(.3, .3, .3, 0, 0), [single[]]@(.59, .59, .59, 0, 0), [single[]]@(.11, .11, .11, 0, 0),
        [single[]]@(0, 0, 0, 1, 0), [single[]]@(0, 0, 0, 0, 1)))
    $attr.SetColorMatrix($m)
  }
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, 32, 32), 0, 0, $src.Width, $src.Height, 'Pixel', $attr)
  $g.Dispose(); $src.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$IconOn = New-TrayIcon $false
$IconOff = New-TrayIcon $true

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $IconOff
$tray.Text = 'AI HUD'
$tray.Visible = $true

# Janela de status
$form = New-Object System.Windows.Forms.Form
$form.Text = 'AI HUD — servidor'
$form.Icon = $IconOn
$form.Size = New-Object System.Drawing.Size 840, 660
$form.StartPosition = 'CenterScreen'
$form.MinimumSize = New-Object System.Drawing.Size 660, 540
$form.ShowInTaskbar = $true

$lblState = New-Object System.Windows.Forms.Label
$lblState.Font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
$lblState.Location = New-Object System.Drawing.Point 12, 10
$lblState.AutoSize = $true

$txtInfo = New-Object System.Windows.Forms.TextBox
$txtInfo.Multiline = $true; $txtInfo.ReadOnly = $true; $txtInfo.BorderStyle = 'None'
$txtInfo.BackColor = $form.BackColor
$txtInfo.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$txtInfo.Location = New-Object System.Drawing.Point 14, 44
$txtInfo.Size = New-Object System.Drawing.Size 800, 174
$txtInfo.ScrollBars = 'Vertical'
$txtInfo.Anchor = 'Top, Left, Right'

$txtLog = New-Object System.Windows.Forms.TextBox
$txtLog.Multiline = $true; $txtLog.ReadOnly = $true; $txtLog.ScrollBars = 'Vertical'; $txtLog.WordWrap = $false
$txtLog.Font = New-Object System.Drawing.Font('Consolas', 9)
$txtLog.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 22); $txtLog.ForeColor = [System.Drawing.Color]::FromArgb(220, 220, 214)
$txtLog.Dock = 'Fill'

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Location = New-Object System.Drawing.Point 12, 224
$tabs.Size = New-Object System.Drawing.Size 800, 320
$tabs.Anchor = 'Top, Left, Right'
$logTab = New-Object System.Windows.Forms.TabPage
$logTab.Text = 'Log do servidor'
$logTab.Controls.Add($txtLog)
$diagnosticTab = New-Object System.Windows.Forms.TabPage
$diagnosticTab.Text = 'Diagnóstico e ocorrências'
$txtDiagnostic = New-Object System.Windows.Forms.TextBox
$txtDiagnostic.Multiline = $true; $txtDiagnostic.ReadOnly = $true
$txtDiagnostic.ScrollBars = 'Vertical'; $txtDiagnostic.WordWrap = $true
$txtDiagnostic.Font = New-Object System.Drawing.Font('Consolas', 9)
$txtDiagnostic.Dock = 'Fill'
$diagnosticTab.Controls.Add($txtDiagnostic)
$tabs.TabPages.AddRange(@($logTab, $diagnosticTab))

$actions = New-Object System.Windows.Forms.FlowLayoutPanel
$actions.Dock = 'Bottom'; $actions.AutoSize = $true; $actions.WrapContents = $true
$actions.Padding = New-Object System.Windows.Forms.Padding 8
$form.Controls.Add($actions)

function New-Button($text, $x) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text; $b.Size = New-Object System.Drawing.Size 142, 36
  $actions.Controls.Add($b); return $b
}
$btnRestart = New-Button 'Reiniciar' 12
$btnToggle = New-Button 'Parar' 150
$btnOpen = New-Button 'Abrir HUD' 288
$btnFolder = New-Button 'Abrir pasta' 426
$btnDiagnostic = New-Button 'Copiar diagnóstico' 564
$form.Controls.AddRange(@($lblState, $txtInfo, $tabs))
$form.add_Layout({
    $height = [math]::Max(80, $actions.Top - $tabs.Top - 8)
    if ($tabs.Height -ne $height) { $tabs.Height = $height }
  })

# Menu do botão direito
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miStatus = $menu.Items.Add('Status e log')
$miDiagnostic = $menu.Items.Add('Copiar diagnóstico')
$miOpen = $menu.Items.Add('Abrir HUD no navegador')
$miPin = $menu.Items.Add('Mostrar PIN')
[void]$menu.Items.Add('-')
$miHttpsOpen = $menu.Items.Add('Abrir HTTPS (Android / PWA)')
$miHttpsCopy = $menu.Items.Add('Copiar endereço HTTPS')
$miHttpsRefresh = $menu.Items.Add('Atualizar HTTPS')
$miTailscale = $menu.Items.Add('Abrir Tailscale')
$miHttpsAuthorize = $menu.Items.Add('Autorizar Tailscale / HTTPS')
[void]$menu.Items.Add('-')
$miRestart = $menu.Items.Add('Reiniciar servidor')
$miToggle = $menu.Items.Add('Parar servidor')
[void]$menu.Items.Add('-')
$miExit = $menu.Items.Add('Sair (para o servidor)')
$tray.ContextMenuStrip = $menu

$script:wantRunning = $true   # o usuário quer o servidor ligado? (o vigia só reinicia nesse caso)
$script:crashes = @()         # horários de quedas, para não reiniciar em laço

function Update-View {
  $st = Get-Status
  $tray.Icon = $(if ($st.Running) { $IconOn } else { $IconOff })
  $text = if (-not $st.Running) { 'AI HUD — parado' } elseif ($st.HttpPending) { 'AI HUD — verificando HTTP' }
    elseif (-not $st.Http) { 'AI HUD — falha no HTTP local' } elseif ($script:httpsState.HttpsOk -eq $false) { 'AI HUD — falha no HTTPS' }
    else { "AI HUD — rodando há $(Format-Duration $st.Since)" }
  $tray.Text = $text.Substring(0, [math]::Min(63, $text.Length))
  $miToggle.Text = $(if ($st.Running) { 'Parar servidor' } else { 'Iniciar servidor' })
  $miHttpsOpen.Enabled = $miHttpsCopy.Enabled = ($st.Running -and $script:httpsState.State -eq 'Ready')
  $miHttpsRefresh.Enabled = ($st.Running -and -not $script:httpsJob)
  $miHttpsAuthorize.Enabled = [bool]$script:httpsState.ActionUrl
  if (-not $form.Visible) { return }
  if ($st.Running) {
    $lblState.Text = '● Rodando' + $(if ($st.HttpPending) { ' (verificando HTTP)' } elseif (-not $st.Http) { ' (falha no HTTP local)' } else { '' })
    $lblState.ForeColor = $(if ($st.Http) { [System.Drawing.Color]::FromArgb(47, 125, 109) } else { [System.Drawing.Color]::DarkOrange })
  } else {
    $lblState.Text = '● Parado'; $lblState.ForeColor = [System.Drawing.Color]::Firebrick
  }
  $btnToggle.Text = $(if ($st.Running) { 'Parar' } else { 'Iniciar' })
  $lines = @()
  if ($st.Running) { $lines += "PID $($st.Pid) · porta $Port · rodando há $(Format-Duration $st.Since)" }
  $lines += 'HTTP local: ' + $(if ($st.HttpPending) { 'verificando...' } elseif ($st.Http) { 'respondendo' } else { $st.HttpError })
  $lines += 'Última atualização do servidor: ' + (Format-HudDiagnosticTime $script:lastLocalOk)
  if ($st.Addresses.Count) { $lines += 'Endereços: ' + ($st.Addresses -join '  ') }
  if ($script:httpsState.Url) { $lines += 'HTTPS (Android / PWA): ' + $script:httpsState.Url }
  $lines += 'Tailscale: ' + $script:httpsState.Message
  if ($null -ne $script:httpsState.HttpsOk) { $lines += 'Acesso HTTPS: ' + $script:httpsState.HttpsMessage }
  if ($st.Pin) { $lines += "PIN: $($st.Pin)" }
  if ($st.Machines.Count) { $lines += 'PCs no hub: ' + ($st.Machines -join ' · ') }
  $txtInfo.Text = $lines -join "`r`n"
  $txtDiagnostic.Text = Get-DiagnosticReport $st
  $atEnd = $txtLog.SelectionStart -ge $txtLog.TextLength - 2
  $log = Get-LogTail 300
  if ($txtLog.Text -ne $log) {
    $txtLog.Text = $log
    if ($atEnd) { $txtLog.SelectionStart = $txtLog.TextLength; $txtLog.ScrollToCaret() }
  }
}

function Show-Status { $form.Show(); $form.WindowState = 'Normal'; $form.Activate(); Update-View }
function Get-DiagnosticReport($Status) {
  if (-not $Status) { $Status = Get-Status }
  $report = Format-HudDiagnostic $Status $script:httpsState $script:lastLocalOk $script:lastHttpsOk @($script:diagnosticEvents) $Port
  return Protect-HudDiagnosticText $report (Get-Config)
}
function Copy-Diagnostic {
  [System.Windows.Forms.Clipboard]::SetText((Get-DiagnosticReport))
  $tray.ShowBalloonTip(2000, 'AI HUD', 'Diagnóstico copiado, sem PIN nem token.', 'Info')
}
function Toggle-Server {
  if (Get-ServerPid) { $script:wantRunning = $false; Stop-Server } else { $script:wantRunning = $true; Start-Server }
  Update-HudLocal
  Update-HudHttps -Force
  Update-View
}
function Restart-Now { $script:wantRunning = $true; Restart-Server; Update-HudLocal; Update-HudHttps -Force; Update-View; $tray.ShowBalloonTip(2000, 'AI HUD', 'Servidor reiniciado.', 'Info') }
function Open-Hud {
  $cfg = Get-Config
  Start-Process "http://127.0.0.1:$Port/?t=$($cfg.token)"
}
function Open-HudHttps {
  if ($script:httpsState.State -eq 'Ready') { Start-Process $script:httpsState.Url }
}
function Open-HudTailscale {
  $exe = Find-HudTailscale
  if ($exe) {
    $gui = Join-Path (Split-Path -Parent $exe) 'tailscale-ipn.exe'
    if (Test-Path -LiteralPath $gui) { Start-Process -FilePath $gui; return }
  }
  [void][System.Windows.Forms.MessageBox]::Show('Instale ou abra o Tailscale pelo menu Iniciar do Windows e conecte sua conta.', 'AI HUD — Tailscale', 'OK', 'Information')
}
# PIN pedido ao entrar no HUD por outro aparelho: mostra em grupos de 4 e copia para a área de transferência
function Show-Pin {
  $cfg = Get-Config
  if (-not $cfg -or -not $cfg.pin) {
    [void][System.Windows.Forms.MessageBox]::Show('Ainda não há PIN: inicie o servidor uma vez para gerá-lo.', 'AI HUD — PIN', 'OK', 'Warning')
    return
  }
  $pin = [string]$cfg.pin
  try { [System.Windows.Forms.Clipboard]::SetText($pin) } catch {}
  $shown = ($pin -replace '(\d{4})(?=\d)', '$1 ')
  [void][System.Windows.Forms.MessageBox]::Show("PIN do AI HUD:`r`n`r`n$shown`r`n`r`n(copiado para a área de transferência)", 'AI HUD — PIN', 'OK', 'Information')
}

$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { Show-Status } })
$miStatus.add_Click({ Show-Status })
$miDiagnostic.add_Click({ Copy-Diagnostic })
$miOpen.add_Click({ Open-Hud })
$miPin.add_Click({ Show-Pin })
$miHttpsOpen.add_Click({ Open-HudHttps })
$miHttpsCopy.add_Click({ if ($script:httpsState.State -eq 'Ready') { [System.Windows.Forms.Clipboard]::SetText($script:httpsState.Url) } })
$miHttpsRefresh.add_Click({ Update-HudHttps -Force; Update-View })
$miTailscale.add_Click({ Open-HudTailscale })
$miHttpsAuthorize.add_Click({
    $link = $script:httpsState.ActionUrl
    if ($link -match '^https://(?:login|controlplane)\.tailscale\.com/') { Start-Process $link }
  })
$miRestart.add_Click({ Restart-Now })
$miToggle.add_Click({ Toggle-Server })
$btnRestart.add_Click({ Restart-Now })
$btnToggle.add_Click({ Toggle-Server })
$btnOpen.add_Click({ Open-Hud })
$btnFolder.add_Click({ Start-Process explorer.exe $Root })
$btnDiagnostic.add_Click({ Copy-Diagnostic })
# Fechar a janela só esconde; o app continua na bandeja
$form.add_FormClosing({ param($s, $e) if ($e.CloseReason -eq 'UserClosing') { $e.Cancel = $true; $form.Hide() } })
$miExit.add_Click({
    $script:wantRunning = $false; Stop-Server
    if ($script:httpsJob) { Stop-Job -Job $script:httpsJob; Remove-Job -Job $script:httpsJob -Force }
    if ($script:localJob) { Stop-Job -Job $script:localJob; Remove-Job -Job $script:localJob -Force }
    $tray.Visible = $false; $tray.Dispose(); $mutex.ReleaseMutex()
    [System.Windows.Forms.Application]::Exit()
  })

# Vigia: a cada 5 s confere o servidor; se caiu sozinho, reinicia (no máximo 3 vezes em 2 min)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
    if ($script:wantRunning -and -not (Get-ServerPid)) {
      $now = Get-Date
      $script:crashes = @($script:crashes | Where-Object { ($now - $_).TotalMinutes -lt 2 }) + $now
      if ($script:crashes.Count -le 3) {
        Add-HudDiagnostic 'Servidor' 'O processo parou inesperadamente; reiniciando automaticamente.' -Repeat
        Start-Server
        $tray.ShowBalloonTip(3000, 'AI HUD', 'O servidor tinha parado e foi reiniciado.', 'Warning')
      } elseif ($script:crashes.Count -eq 4) {
        Add-HudDiagnostic 'Servidor' 'Reinício automático suspenso após várias quedas em dois minutos.'
        $tray.ShowBalloonTip(5000, 'AI HUD', 'O servidor caiu várias vezes. Veja o log.', 'Error')
      }
    }
    Update-HudLocal
    Update-HudHttps
    Update-View
  })

# Ao abrir: usa o servidor que já estiver rodando, senão inicia
Start-Server
Update-HudLocal
Update-HudHttps
Update-View
$timer.Start()
[System.Windows.Forms.Application]::Run()
