# Ponte: atalhos antigos na pasta Inicializar apontam para este caminho. O código fica em platform\windows\tray\.
& (Join-Path $PSScriptRoot '..\..\platform\windows\tray\ai-hud-tray.ps1') @args
