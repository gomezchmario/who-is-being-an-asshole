' Invisible launcher for ping-scan.ps1 — no console window at all.
Dim shell, scriptDir
Set shell = CreateObject("Wscript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "ping-scan.ps1""", 0, False
