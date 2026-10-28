# Integração do HTTPS do HUD. Este arquivo só define funções; a bandeja as executa em um job.
# Compatível com Windows PowerShell 5.1, sem módulos externos.

function Find-HudTailscale {
  $command = Get-Command tailscale.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if ($base) {
      $candidate = Join-Path $base 'Tailscale\tailscale.exe'
      if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
  }
  return $null
}

function Invoke-HudTailscale([string]$Executable, [string[]]$Arguments, [int]$TimeoutSeconds = 15) {
  # Os argumentos são internos (verbos fixos, porta numérica e URL de loopback), sem shell.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Executable
  $psi.Arguments = $Arguments -join ' '
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  try {
    [void]$process.Start()
    $process.StandardInput.Close()
    # Drena ambos os pipes enquanto espera, inclusive se o CLI emitir muita saída.
    $output = $process.StandardOutput.ReadToEndAsync()
    $errors = $process.StandardError.ReadToEndAsync()
    $timedOut = -not $process.WaitForExit($TimeoutSeconds * 1000)
    if ($timedOut) { $process.Kill(); $process.WaitForExit() }
    return [pscustomobject]@{
      ExitCode = $(if ($timedOut) { -1 } else { $process.ExitCode })
      Output = $output.Result; Error = $errors.Result; TimedOut = $timedOut
    }
  } finally { $process.Dispose() }
}

function New-HudTailscaleState([string]$State, [string]$Message, [string]$Url = '', [string]$ActionUrl = '') {
  return [pscustomobject]@{ State = $State; Message = $Message; Url = $Url; ActionUrl = $ActionUrl }
}

function Get-HudServeRoute($Config, [string]$DnsName, [int]$Port) {
  $hostPort = "${DnsName}:443"
  if ($Config.AllowFunnel -and $Config.AllowFunnel.$hostPort) {
    return 'Public'  # Nunca adota nem altera uma rota que já está publicada via Funnel.
  }
  foreach ($session in @($Config.Foreground.PSObject.Properties)) {
    if ($session.Value.TCP.'443') { return 'Conflict' }
  }
  $tcp = $Config.TCP.'443'
  if ($tcp -and -not $tcp.HTTPS) { return 'Conflict' }
  $web = $Config.Web.$hostPort
  $handler = $web.Handlers.'/'
  if (-not $handler) { return 'Missing' }
  $target = [string]$handler.Proxy
  if ($tcp.HTTPS -and (@("http://127.0.0.1:$Port", "http://localhost:$Port") -contains $target.TrimEnd('/'))) {
    return 'Ready'
  }
  return 'Conflict'
}

function Sync-HudTailscaleServe([int]$Port) {
  try {
    $exe = Find-HudTailscale
    if (-not $exe) { return New-HudTailscaleState 'Missing' 'Tailscale não instalado. O HUD continua disponível na rede local.' }
    $result = Invoke-HudTailscale $exe @('status', '--json')
    # Quando não há login, algumas versões retornam código 1 com JSON válido.
    $status = $result.Output | ConvertFrom-Json
    if (-not $status.BackendState) { throw 'O serviço Tailscale não respondeu. Abra o Tailscale e tente novamente.' }
    if ($status.BackendState -ne 'Running') {
      return New-HudTailscaleState 'Offline' 'Abra o Tailscale, faça login e conecte para ativar o HTTPS.' '' ([string]$status.AuthURL)
    }
    $dns = ([string]$status.Self.DNSName).TrimEnd('.')
    if (-not $dns) { throw 'O Tailscale ainda não informou o nome HTTPS deste PC.' }
    $url = "https://$dns/"
    $result = Invoke-HudTailscale $exe @('serve', 'status', '--json')
    if ($result.ExitCode -ne 0) { throw 'Não foi possível consultar o Tailscale Serve.' }
    $config = $result.Output | ConvertFrom-Json
    if (-not $config) { throw 'O Tailscale Serve retornou uma configuração inválida.' }
    $route = Get-HudServeRoute $config $dns $Port
    if ($route -eq 'Ready') { return New-HudTailscaleState 'Ready' 'HTTPS ativo no Tailscale.' $url }
    if ($route -eq 'Public') { return New-HudTailscaleState 'Conflict' 'Já existe um Funnel público nesta porta. Revise a configuração no Tailscale.' }
    if ($route -eq 'Conflict') { return New-HudTailscaleState 'Conflict' 'A porta HTTPS 443 do Tailscale já está ocupada por outro serviço.' }

    $result = Invoke-HudTailscale $exe @('serve', '--bg', '--yes', '--https=443', "http://127.0.0.1:$Port")
    $text = $result.Output + "`n" + $result.Error
    # O primeiro uso pode exigir consentimento de HTTPS no painel do Tailscale.
    $link = [regex]::Match($text, 'https://(?:login|controlplane)\.tailscale\.com/[^\s<>"'']+')
    if ($link.Success) {
      return New-HudTailscaleState 'Authorization' 'Autorize o HTTPS pelo menu da bandeja e clique em Atualizar HTTPS.' '' $link.Value
    }
    if ($result.TimedOut) { throw 'O Tailscale Serve demorou para responder. Verifique o Tailscale e tente novamente.' }
    if ($result.ExitCode -ne 0) {
      $detail = $text.Trim()
      if ($detail.Length -gt 400) { $detail = $detail.Substring(0, 400) }
      throw "Não foi possível ativar o HTTPS: $detail"
    }
    # Só anuncia a URL depois de confirmar o destino na configuração efetiva.
    $result = Invoke-HudTailscale $exe @('serve', 'status', '--json')
    if ($result.ExitCode -eq 0 -and (Get-HudServeRoute ($result.Output | ConvertFrom-Json) $dns $Port) -eq 'Ready') {
      return New-HudTailscaleState 'Ready' 'HTTPS ativo no Tailscale.' $url
    }
    throw 'O Tailscale Serve ainda não confirmou o HTTPS do HUD. Tente atualizar novamente.'
  } catch { return New-HudTailscaleState 'Error' $_.Exception.Message }
}
