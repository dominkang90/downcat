@echo off
setlocal
rem Self-elevate if not running as administrator (one UAC prompt)
net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo Administrator rights are required. Click "Yes" on the prompt...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
pushd "%~dp0"
echo.
echo [DownCat] Installing the Chrome/Edge extension...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\downcat-ext-policy.ps1" -CrxPath "build\downcat-ext.crx" -ConfigPath "config.json"
echo.
echo Done. Fully quit Chrome/Edge, then reopen -- the extension installs automatically.
echo (Success = the DownCat icon appears on the toolbar.)
echo.
pause
