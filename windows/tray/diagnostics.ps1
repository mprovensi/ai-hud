# Diagnóstico sem interface; executado em jobs e testável sem mudar o servidor real.
function Get-HudLocalDiagnostic([int]$Port, [string]$Token) {
  $state = [pscustomobject]@{ Ok = $false; Error = ''; Machines = @(); CheckedAt = (Get-Date); Version = '' }
  try {
    $uri = [uri]"http://127.0.0.1:$Port/api/snapshot"
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $session.Cookies.Add($uri, (New-Object System.Net.Cookie('hud', $Token, '/')))
    $snapshot = Invoke-RestMethod -Uri $uri -WebSession $session -TimeoutSec 4
    if (-not $snapshot.now -or -not $snapshot.PSObject.Properties['active']) { throw 'Resposta inválida do servidor.' }
    $state.Ok = $true
    $state.Version = [string]$snapshot.appVersion
    $state.Machines = @($snapshot.machines | ForEach-Object { "$($_.name): $(if ($_.ok) { 'online' } else { 'fora do ar' })" })
  } catch { $state.Error = $_.Exception.Message }
  $state.CheckedAt = Get-Date
  return $state
}

function Protect-HudDiagnosticText([string]$Text, $Config) {
  foreach ($secret in @($Config.token, $Config.pin)) {
    if ($secret) { $Text = $Text.Replace([string]$secret, '[oculto]') }
  }
  $Text = $Text -replace '([?&]t=)[^\s&#"'']+', '$1[oculto]'
  $Text = $Text -replace '(?i)((?:token|pin|hud)\s*[:=]\s*)[^\s;,]+', '$1[oculto]'
  return $Text
}

function Format-HudDiagnosticTime($Time) {
  if (-not $Time) { return 'ainda não confirmado' }
  try { return ([datetime]$Time).ToString('dd/MM HH:mm:ss') } catch { return 'horário indisponível' }
}

function Format-HudDiagnostic($Server, $Https, $LastLocalOk, $LastHttpsOk, $Events, [int]$Port) {
  $lines = @('AI HUD — diagnóstico', ('Gerado em: ' + (Get-Date).ToString('dd/MM/yyyy HH:mm:ss')),
    "Servidor: $(if ($Server.Running) { 'rodando (PID ' + $Server.Pid + ')' } else { 'parado' }) · porta $Port",
    "HTTP local: $(if ($Server.HttpPending) { 'verificando...' } elseif ($Server.Http) { 'respondendo' } else { $Server.HttpError })",
    ('Última resposta HTTP local: ' + (Format-HudDiagnosticTime $LastLocalOk)))
  if ($Server.Version) { $lines += 'Versão da interface: ' + $Server.Version }
  $connection = if ($Https.BackendState -eq 'Running') { 'conectado' } elseif ($Https.State -eq 'Missing') { 'não instalado' } elseif ($Https.BackendState) { $Https.BackendState } else { 'não confirmado' }
  $lines += 'Tailscale: ' + $connection
  $lines += 'Configuração HTTPS: ' + $Https.Message
  if ($Https.Url) { $lines += 'Endereço HTTPS: ' + $Https.Url }
  if ($null -ne $Https.HttpsOk) { $lines += 'Acesso HTTPS: ' + $Https.HttpsMessage }
  $lines += 'Última verificação Tailscale/HTTPS: ' + (Format-HudDiagnosticTime $Https.CheckedAt)
  $lines += 'Última resposta HTTPS: ' + (Format-HudDiagnosticTime $LastHttpsOk)
  if ($Server.Addresses.Count) { $lines += 'Rede local: ' + ($Server.Addresses -join '  ') }
  if ($Server.Machines.Count) { $lines += 'PCs no hub: ' + ($Server.Machines -join ' · ') }
  $lines += ''; $lines += 'Ocorrências recentes (até 20):'
  if (-not @($Events).Count) { $lines += 'Nenhuma ocorrência registrada.' }
  foreach ($event in @($Events)) { $lines += "$(Format-HudDiagnosticTime $event.At) · $($event.Source) · $($event.Message)" }
  return $lines -join "`r`n"
}
