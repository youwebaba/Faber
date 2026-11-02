@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Sophia-Harness.ps1" %*
exit /b %ERRORLEVEL%
