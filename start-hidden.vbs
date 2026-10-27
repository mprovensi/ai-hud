' Inicia o servidor do AI HUD sem janela (para colocar na pasta Inicializar do Windows).
' Usa a pasta onde este arquivo está; se for uma cópia em Inicializar, usa D:\Projetos\ai-hud.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FileExists(dir & "\server.js") Then dir = "D:\Projetos\ai-hud"
sh.CurrentDirectory = dir
sh.Run "cmd /c node server.js > server.log 2>&1", 0, False
