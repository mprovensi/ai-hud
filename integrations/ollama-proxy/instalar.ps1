# Instala o proxy de registro do Ollama para iniciar com o Windows.
#   .\instalar.ps1              instala e inicia
#   .\instalar.ps1 -Remover     desfaz tudo e volta o Ollama ao normal
param([switch]$Remover)

$dir     = $PSScriptRoot
$task    = "Ollama Log Proxy"
$startup = Join-Path ([Environment]::GetFolderPath("Startup")) "Ollama.lnk"
$backup  = Join-Path $dir "..\..\data\Ollama.lnk"  # atalho original do app, para -Remover

function Stop-Ollama {
    Get-Process "ollama app", ollama -ErrorAction SilentlyContinue | Stop-Process -Force
    # Proxy em Node (atual) ou em Python (versão anterior, proxy.py)
    Get-CimInstance Win32_Process -Filter "name='node.exe' OR name='pythonw.exe'" |
        Where-Object { $_.CommandLine -like "*ollama-proxy*proxy.*" -or $_.CommandLine -like "*proxy.py*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep 2
}

if ($Remover) {
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
    Stop-Ollama
    if (Test-Path $backup) { Move-Item $backup $startup -Force }
    Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"
    Write-Host "Proxy removido; Ollama voltou ao normal."
    return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js não encontrado no PATH (o proxy precisa do Node 22.5 ou mais novo)." }

# O app do Ollama sobe o próprio servidor na 11434 e brigaria pela porta.
if (Test-Path $startup) {
    New-Item -ItemType Directory -Force (Split-Path $backup) | Out-Null
    Move-Item $startup $backup -Force
}

# Node é programa de console: o PowerShell oculto evita a janela preta no login.
# Sem console, o proxy grava o registro em data\ollama-proxy.log.
$command  = "& '$node' '$dir\proxy.js' --spawn-ollama"
$action   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -Command `"$command`"" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Stop-Ollama
Start-ScheduledTask -TaskName $task
Write-Host "Proxy instalado e iniciado. Conversas em $(Resolve-Path "$dir\..\..\data")\ollama-conversas.sqlite"
