@echo off
setlocal
cd /d "%~dp0"

rem First run from source (ZIP / git): Electron is not installed yet -> install it once.
if exist ".\node_modules\electron\dist\electron.exe" goto run

where npm >nul 2>&1
if errorlevel 1 (
  echo.
  echo [DownCat] Node.js is required for the first run.
  echo   1. Install Node.js LTS from https://nodejs.org
  echo   2. Double-click this file again.
  echo.
  start "" "https://nodejs.org/"
  pause
  exit /b 1
)

echo.
echo [DownCat] First run: installing Electron (about 1-3 minutes, once only)...
echo.
call npm install
if errorlevel 1 goto failed
if not exist ".\node_modules\electron\dist\electron.exe" goto failed

:run
start "" ".\node_modules\electron\dist\electron.exe" .
exit /b 0

:failed
echo.
echo [DownCat] Install failed. Check your internet connection and run this file again.
echo   (or open this folder in a terminal and run: npm install)
echo.
pause
exit /b 1
