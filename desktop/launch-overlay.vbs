' Hidden launcher for the DSH task-overlay desktop window.
' Runs under wscript.exe (no console window); WScript.Shell.Run with window style 0
' launches pwsh fully hidden even when Windows Terminal is the default terminal.
Dim fso, scriptDir, scriptPath, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = scriptDir & "\task-overlay.ps1"
Set sh = CreateObject("WScript.Shell")
cmd = "pwsh -NoProfile -STA -ExecutionPolicy Bypass -File " & Chr(34) & scriptPath & Chr(34)
sh.Run cmd, 0, False
