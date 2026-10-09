@echo off
rem DSH task-overlay desktop window launcher.
rem Delegate to the VBS launcher so no console / Windows Terminal window appears
rem (a plain "start pwsh" would be captured by Windows Terminal when it is the
rem default terminal app, leaving a terminal window behind).
wscript "%~dp0launch-overlay.vbs"
