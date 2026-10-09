' Hidden launcher for the DSH task-overlay desktop window.
' Runs under wscript.exe (no console window); WScript.Shell.Run with window
' style 0 launches PowerShell fully hidden even when Windows Terminal is the
' system default terminal (which ignores -WindowStyle).
' Prefers PowerShell 7 (pwsh); falls back to Windows PowerShell 5.1.
Dim fso, sh, scriptDir, scriptPath, launched
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = scriptDir & "\task-overlay.ps1"

launched = False
On Error Resume Next
sh.Run "pwsh -NoProfile -STA -ExecutionPolicy Bypass -File " & Chr(34) & scriptPath & Chr(34), 0, False
If Err.Number = 0 Then launched = True
Err.Clear
If Not launched Then
  sh.Run "powershell -NoProfile -STA -ExecutionPolicy Bypass -File " & Chr(34) & scriptPath & Chr(34), 0, False
  If Err.Number = 0 Then launched = True
  Err.Clear
End If
On Error GoTo 0

If Not launched Then
  MsgBox "Failed to start PowerShell. Install PowerShell 7 (winget install Microsoft.PowerShell) or run desktop\task-overlay.ps1 manually.", 48, "DSH task overlay"
End If
