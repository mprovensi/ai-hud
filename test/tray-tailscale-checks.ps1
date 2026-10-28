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
