@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Faber.ps1" %*
exit /b %ERRORLEVEL%
