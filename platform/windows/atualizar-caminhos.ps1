# Atualiza os caminhos do AI HUD gravados fora do repositório para a estrutura nova
# (integrations/ e platform/). Enquanto não rodar, as pontes nos caminhos antigos mantêm tudo funcionando.
#   .\atualizar-caminhos.ps1            mostra o que mudaria
#   .\atualizar-caminhos.ps1 -Aplicar   aplica (guarda uma cópia .bak de cada arquivo alterado)
# Rode em cada PC que usa o HUD. Depois de rodar em todos, as pontes (claude\, windows\tray\,
# ollama-proxy\proxy.js) podem ser apagadas.
param([switch]$Aplicar)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$fwd = $root -replace '\\', '/'
$changes = 0

# Troca, num arquivo de texto, os caminhos antigos pelos novos (barras / e \)
function Update-File([string]$file, [string[][]]$pairs) {
  if (-not (Test-Path -LiteralPath $file)) { return }
  $text = [IO.File]::ReadAllText($file)
  $new = $text
  foreach ($p in $pairs) { $new = $new.Replace($p[0], $p[1]) }
  if ($new -eq $text) { Write-Host "ok (nada a mudar): $file"; return }
  $script:changes++
  Write-Host "mudar: $file"
  foreach ($p in $pairs) { if ($text.Contains($p[0])) { Write-Host "    $($p[0])  ->  $($p[1])" } }
  if ($Aplicar) {
    Copy-Item -LiteralPath $file -Destination "$file.bak" -Force
    [IO.File]::WriteAllText($file, $new, (New-Object Text.UTF8Encoding $false))
  }
}

$hooks = @(
  @("$fwd/claude/", "$fwd/integrations/claude/"),
  @("$root\claude\", "$root\integrations\claude\"),
  @(($root -replace '\\', '\\') + '\\claude\\', ($root -replace '\\', '\\') + '\\integrations\\claude\\')  # JSON com \\
)

# Claude Code: statusline e hooks
Update-File (Join-Path $env:USERPROFILE '.claude\settings.json') $hooks
# Codex: hooks (se usar o hook-stop do HUD)
Update-File (Join-Path $env:USERPROFILE '.codex\hooks.json') $hooks
Update-File (Join-Path $env:USERPROFILE '.codex\config.toml') $hooks

# Bandeja: cópias do start-tray.vbs na pasta Inicializar
$startup = [Environment]::GetFolderPath('Startup')
Get-ChildItem -LiteralPath $startup -Filter *.vbs -ErrorAction SilentlyContinue | ForEach-Object {
  Update-File $_.FullName @(, @("$root\windows\tray", "$root\platform\windows\tray"))
}

# ollama-proxy: tarefa agendada
$task = Get-ScheduledTask -TaskName 'Ollama Log Proxy' -ErrorAction SilentlyContinue
if ($task) {
  $action = $task.Actions[0]
  $taskArgs = [string]$action.Arguments
  if ($taskArgs -like '*proxy.py*') {
    $script:changes++
    Write-Host "mudar: tarefa 'Ollama Log Proxy' ainda usa o proxy em Python; rode integrations\ollama-proxy\instalar.ps1"
  } elseif ($taskArgs.Contains("$root\ollama-proxy\proxy.js")) {
    $script:changes++
    $newArgs = $taskArgs.Replace("$root\ollama-proxy\proxy.js", "$root\integrations\ollama-proxy\proxy.js")
    Write-Host "mudar: tarefa 'Ollama Log Proxy'`n    $taskArgs`n    ->  $newArgs"
    if ($Aplicar) {
      $new = New-ScheduledTaskAction -Execute $action.Execute -Argument $newArgs -WorkingDirectory "$root\integrations\ollama-proxy"
      Set-ScheduledTask -TaskName 'Ollama Log Proxy' -Action $new | Out-Null
    }
  } else { Write-Host "ok (nada a mudar): tarefa 'Ollama Log Proxy'" }
}

if (-not $changes) { Write-Host "`nTudo já usa os caminhos novos." }
elseif (-not $Aplicar) { Write-Host "`n$changes item(ns) a mudar. Rode de novo com -Aplicar." }
else { Write-Host "`n$changes item(ns) atualizado(s). Reinicie o Claude Code/Codex para recarregar os hooks." }
