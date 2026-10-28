$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\windows\tray\tailscale-serve.ps1')
$script:checks = 0
function Assert-Hud($condition, [string]$message) {
  $script:checks++
  if (-not $condition) { throw $message }
}

# Testa o executor real, sem chamar Tailscale nem alterar a rede.
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$result = Invoke-HudTailscale $powershell @('-NoProfile', '-NonInteractive', '-Command', '"[Console]::Out.Write((''o'' * 100000)); [Console]::Error.Write((''e'' * 100000)); exit 7"')
Assert-Hud ($result.ExitCode -eq 7 -and $result.Output.Length -eq 100000 -and $result.Error.Length -eq 100000) 'O executor deve drenar stdout/stderr e preservar o código de saída.'
$result = Invoke-HudTailscale $powershell @('-NoProfile', '-NonInteractive', '-Command', '"Start-Sleep -Seconds 10"') 1
Assert-Hud ($result.TimedOut -and $result.ExitCode -eq -1) 'O CLI deve ser encerrado ao exceder o timeout.'

# As demais chamadas ao CLI são simuladas; nenhum Serve real é configurado pelos testes.
$script:found = $true
$script:calls = New-Object System.Collections.ArrayList
$script:queue = New-Object System.Collections.Queue
function Find-HudTailscale { if ($script:found) { return 'fake-tailscale.exe' }; return $null }
function Invoke-HudTailscale([string]$Executable, [string[]]$Arguments, [int]$TimeoutSeconds = 15) {
  [void]$script:calls.Add(($Arguments -join ' '))
  if (-not $script:queue.Count) { throw 'Chamada inesperada ao CLI.' }
  return $script:queue.Dequeue()
}
function Add-Response($value, [int]$code = 0, [bool]$timedOut = $false) {
  $output = if ($value -is [string]) { $value } else { $value | ConvertTo-Json -Depth 20 -Compress }
  $script:queue.Enqueue([pscustomobject]@{ Output = $output; Error = ''; ExitCode = $code; TimedOut = $timedOut })
}
function Reset-Scenario {
  $script:calls.Clear(); $script:queue.Clear()
  Add-Response @{ BackendState = 'Running'; Self = @{ DNSName = 'pc.test.ts.net.' } }
}
function Serve-Config([int]$port = 8787) {
  return @{ TCP = @{ '443' = @{ HTTPS = $true } }; Web = @{ 'pc.test.ts.net:443' = @{ Handlers = @{ '/' = @{ Proxy = "http://127.0.0.1:$port" } } } } }
}

$script:found = $false
Assert-Hud ((Sync-HudTailscaleServe 8787).State -eq 'Missing' -and $script:calls.Count -eq 0) 'Sem Tailscale, deve manter apenas o HTTP local.'
$script:found = $true
Add-Response @{ BackendState = 'NeedsLogin'; AuthURL = 'https://login.tailscale.com/a/test' } 1
$state = Sync-HudTailscaleServe 8787
Assert-Hud ($state.State -eq 'Offline' -and $state.ActionUrl -eq 'https://login.tailscale.com/a/test' -and $script:calls.Count -eq 1) 'Login pendente deve informar a ação sem configurar Serve.'

Reset-Scenario
Add-Response (Serve-Config)
$state = Sync-HudTailscaleServe 8787
Assert-Hud ($state.State -eq 'Ready' -and $state.Url -eq 'https://pc.test.ts.net/' -and $script:calls.Count -eq 2) 'Uma rota correta não deve ser reconfigurada.'

Reset-Scenario
Add-Response @{}
Add-Response 'Available within your tailnet'
Add-Response (Serve-Config 8796)
$state = Sync-HudTailscaleServe 8796
Assert-Hud ($state.State -eq 'Ready' -and $script:calls[2] -eq 'serve --bg --yes --https=443 http://127.0.0.1:8796') 'A ativação deve usar a porta do HUD e confirmar a configuração.'

Reset-Scenario
Add-Response (Serve-Config 3000)
$state = Sync-HudTailscaleServe 8787
Assert-Hud ($state.State -eq 'Conflict' -and -not $state.Url -and $script:calls.Count -eq 2) 'Nunca substituir o proxy de outro serviço.'

Reset-Scenario
$config = Serve-Config
$config.AllowFunnel = @{ 'pc.test.ts.net:443' = $true }
Add-Response $config
$state = Sync-HudTailscaleServe 8787
Assert-Hud ($state.State -eq 'Conflict' -and $script:calls.Count -eq 2) 'Nunca adotar nem alterar um Funnel público.'

Reset-Scenario
Add-Response @{ Foreground = @{ session = (Serve-Config) } }
Assert-Hud ((Sync-HudTailscaleServe 8787).State -eq 'Conflict' -and $script:calls.Count -eq 2) 'Nunca substituir um Serve em foreground.'

Reset-Scenario
Add-Response @{ TCP = @{ '443' = @{ TCPForward = 'localhost:22' } } }
Assert-Hud ((Sync-HudTailscaleServe 8787).State -eq 'Conflict' -and $script:calls.Count -eq 2) 'Nunca substituir encaminhamento TCP na porta 443.'

Reset-Scenario
Add-Response @{}
Add-Response "Enable HTTPS: https://login.tailscale.com/f/serve?node=test`n" -1 $true
$state = Sync-HudTailscaleServe 8787
Assert-Hud ($state.State -eq 'Authorization' -and $state.ActionUrl -eq 'https://login.tailscale.com/f/serve?node=test' -and -not $state.Url) 'Deve apresentar o link de consentimento mesmo quando o CLI aguarda até o timeout.'

Reset-Scenario
Add-Response @{}
Add-Response 'permission denied' 1
$state = Sync-HudTailscaleServe 8787
Assert-Hud ($state.State -eq 'Error' -and $state.Message.Contains('permission denied') -and -not $state.Url) 'Falha de configuração não pode anunciar HTTPS ativo.'

Reset-Scenario
Add-Response @{}
Add-Response 'OK'
Add-Response @{}
Assert-Hud ((Sync-HudTailscaleServe 8787).State -eq 'Error') 'A saída de sucesso do comando não substitui a verificação da rota.'

Reset-Scenario
Add-Response 'invalid json'
Assert-Hud ((Sync-HudTailscaleServe 8787).State -eq 'Error' -and $script:calls.Count -eq 2) 'Status inválido deve impedir mudanças na configuração.'

"Tailscale tray checks passed ($script:checks assertions)."

. (Join-Path $PSScriptRoot '..\windows\tray\diagnostics.ps1')
$secretConfig = [pscustomobject]@{ token = 'a-secret-token'; pin = '12345678' }
$protected = Protect-HudDiagnosticText 'token=a-secret-token PIN:12345678 https://hud/?t=other-secret' $secretConfig
Assert-Hud (-not $protected.Contains('a-secret-token') -and -not $protected.Contains('12345678') -and -not $protected.Contains('other-secret')) 'O diagnóstico não pode conter token nem PIN.'

function Invoke-RestMethod($Uri, $WebSession, $TimeoutSec) {
  Assert-Hud (-not ([string]$Uri).Contains('?')) 'A consulta local não deve incluir token na URL.'
  Assert-Hud ($WebSession.Cookies.GetCookies($Uri)['hud'].Value -eq 'a-secret-token') 'A consulta local deve usar o cookie de autenticação.'
  return [pscustomobject]@{ now = 1000; active = @(); appVersion = 'version'; machines = @([pscustomobject]@{ name = 'PC'; ok = $true }) }
}
$local = Get-HudLocalDiagnostic 8787 $secretConfig.token
Assert-Hud ($local.Ok -and $local.Version -eq 'version' -and $local.Machines[0] -eq 'PC: online') 'A consulta local deve confirmar o HTTP e a versão.'

function Invoke-RestMethod { throw 'falha HTTP local' }
$local = Get-HudLocalDiagnostic 8787 $secretConfig.token
Assert-Hud (-not $local.Ok -and $local.Error -eq 'falha HTTP local') 'Uma falha local deve permanecer no diagnóstico.'

function Sync-HudTailscaleServe { return New-HudTailscaleState 'Ready' 'HTTPS configurado' 'https://pc.test.ts.net/' }
function Invoke-WebRequest { throw 'certificado não confiável' }
$https = Get-HudHttpsDiagnostic 8787
Assert-Hud ($https.State -eq 'Ready' -and $https.HttpsOk -eq $false -and $https.HttpsMessage.Contains('certificado')) 'Uma rota configurada não significa que o acesso HTTPS está funcionando.'

function Invoke-WebRequest { return [pscustomobject]@{ StatusCode = 200; Content = 'AI HUD' } }
$https = Get-HudHttpsDiagnostic 8787
Assert-Hud ($https.HttpsOk -eq $true -and $https.CheckedAt) 'O diagnóstico deve verificar a resposta real do HTTPS.'
$server = [pscustomobject]@{ Running = $true; Pid = 123; HttpPending = $false; Http = $false; HttpError = 'falha HTTP local'; Version = 'version'; Addresses = @(); Machines = @() }
$events = @([pscustomobject]@{ At = 'data inválida'; Source = 'Teste'; Message = 'PIN:12345678 token=a-secret-token' })
$report = Protect-HudDiagnosticText (Format-HudDiagnostic $server $https (Get-Date) (Get-Date) $events 8787) $secretConfig
Assert-Hud ($report.Contains('falha HTTP local') -and $report.Contains('HTTP 200') -and -not $report.Contains('a-secret-token') -and -not $report.Contains('12345678')) 'O relatório deve separar HTTP/HTTPS e ocultar segredos, tolerando eventos inválidos.'
"Tailscale diagnostic checks passed ($script:checks assertions)."

# Usa apenas funções do app, sem iniciar bandeja, servidor nem Tailscale.
$trayFile = Join-Path $PSScriptRoot '..\windows\tray\ai-hud-tray.ps1'
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($trayFile, [ref]$tokens, [ref]$parseErrors)
Assert-Hud ($parseErrors.Count -eq 0) 'A bandeja deve ser válida no Windows PowerShell 5.1.'
foreach ($name in @('Add-HudDiagnostic', 'Format-Duration')) {
  $definition = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  Invoke-Expression $definition.Extent.Text
}
function Get-Config { return $secretConfig }
$script:diagnosticEvents = @(); $script:diagnosticKeys = @{}
$script:eventFile = Join-Path ([System.IO.Path]::GetTempPath()) ('hud-events-' + [guid]::NewGuid().ToString('N') + '.json')
try {
  Add-HudDiagnostic 'Teste' 'PIN:12345678 token=a-secret-token'
  Add-HudDiagnostic 'Teste' 'PIN:12345678 token=a-secret-token'
  Assert-Hud ($script:diagnosticEvents.Count -eq 1) 'Consultas repetidas não devem repetir a mesma ocorrência.'
  for ($i = 0; $i -lt 25; $i++) { Add-HudDiagnostic 'Teste' "falha $i" }
  Assert-Hud ($script:diagnosticEvents.Count -eq 20 -and $script:diagnosticEvents[0].Message -eq 'falha 24') 'O histórico deve ser limitado às 20 ocorrências mais recentes.'
  $saved = Get-Content -Raw -Encoding UTF8 -LiteralPath $script:eventFile
  Assert-Hud (-not $saved.Contains('a-secret-token') -and -not $saved.Contains('12345678')) 'O histórico persistido não pode salvar credenciais.'
} finally {
  if ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($script:eventFile)) -ne [System.IO.Path]::GetTempPath().TrimEnd('\')) { throw 'Arquivo de teste fora da pasta temporária.' }
  Remove-Item -LiteralPath $script:eventFile -Force -ErrorAction SilentlyContinue
}

# Renderização opcional em memória: não mostra janela nem ícone, usa só dados de teste.
if ($env:AI_HUD_RENDER_TRAY) {
  $Root = Split-Path -Parent $PSScriptRoot
  $Port = 8787
  $source = Get-Content -LiteralPath $trayFile -Raw -Encoding UTF8
  $ui = $source.Substring($source.IndexOf('Add-Type -AssemblyName System.Windows.Forms'))
  $ui = $ui.Substring(0, $ui.IndexOf('# Ao abrir:'))
  $ui = $ui.Replace('Local\AIHUDTray', ('Local\AIHUDTrayTest-' + [guid]::NewGuid().ToString('N')))
  $ui = $ui.Replace('$tray.Visible = $true', '$tray.Visible = $false')
  $ui = $ui.Replace('if (-not $form.Visible) { return }', '')
  function Get-Status {
    return [pscustomobject]@{ Running = $true; Pid = 123; Since = (Get-Date).AddHours(-2); HttpPending = $false;
      Http = $true; HttpError = ''; Version = 'teste123'; Pin = '12345678'; Addresses = @('http://192.168.1.2:8787'); Machines = @('PC: online') }
  }
  function Get-LogTail { return "Servidor iniciado.`r`nAguardando consultas do HUD..." }
  $script:httpsState = New-HudTailscaleState 'Ready' 'HTTPS ativo no Tailscale.' 'https://pc.test.ts.net/'
  $script:httpsState | Add-Member -NotePropertyMembers @{ HttpsOk = $true; HttpsMessage = 'Respondendo com certificado confiável (HTTP 200).'; CheckedAt = (Get-Date) }
  $script:lastLocalOk = Get-Date; $script:lastHttpsOk = Get-Date
  Invoke-Expression $ui
  function Initialize-RenderHandle($control) {
    $null = $control.Handle
    foreach ($child in $control.Controls) { Initialize-RenderHandle $child }
  }
  try {
    Update-View
    $tabs.SelectedIndex = 1
    foreach ($size in @(@(840, 660), @(660, 540))) {
      $form.Size = New-Object System.Drawing.Size $size[0], $size[1]
      $form.PerformLayout()
      Initialize-RenderHandle $form
      Assert-Hud ($tabs.Bottom -lt $actions.Top) 'O diagnóstico não pode sobrepor os botões ao redimensionar.'
      foreach ($control in $actions.Controls) {
        Assert-Hud ($control.Right -le $actions.ClientSize.Width -and $control.Bottom -le $actions.ClientSize.Height) 'Todos os botões devem caber no painel.'
      }
      $bitmap = New-Object System.Drawing.Bitmap $form.Width, $form.Height
      try {
        $form.DrawToBitmap($bitmap, (New-Object System.Drawing.Rectangle 0, 0, $form.Width, $form.Height))
        $bitmap.Save((Join-Path $env:AI_HUD_RENDER_TRAY "tray-$($size[0]).png"))
      } finally { $bitmap.Dispose() }
    }
  } finally { $timer.Dispose(); $form.Dispose(); $tray.Dispose(); $mutex.ReleaseMutex(); $mutex.Dispose() }
}
"Tray event checks passed ($script:checks assertions)."
