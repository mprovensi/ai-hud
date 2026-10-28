' Abre o AI HUD na bandeja do Windows, sem janela de console.
' Para iniciar junto com o Windows: copie este arquivo para a pasta Inicializar (Win+R, shell:startup).
' Se a cópia estiver fora da pasta do projeto, usa D:\Projetos\ai-hud\windows\tray.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FileExists(dir & "\ai-hud-tray.ps1") Then dir = "D:\Projetos\ai-hud\windows\tray"
sh.Run "powershell.exe -NoProfile -STA -WindowStyle Hidden -File """ & dir & "\ai-hud-tray.ps1""", 0, False
