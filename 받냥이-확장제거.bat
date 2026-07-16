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
echo [DownCat] Removing the Chrome/Edge extension auto-install policy...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\downcat-ext-policy.ps1" -Uninstall
echo.
echo Done. Reopen Chrome/Edge and the extension will be gone.
echo.
pause
