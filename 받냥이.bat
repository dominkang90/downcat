@echo off
setlocal
cd /d "%~dp0"

rem Node.js is needed to install/update Electron (the app runtime).
where node >nul 2>&1
if errorlevel 1 (
  if exist ".\node_modules\electron\dist\electron.exe" goto run
  echo.
  echo [DownCat] Node.js is required for the first run.
  echo   1. Install Node.js LTS from https://nodejs.org
  echo   2. Double-click this file again.
  echo.
  start "" "https://nodejs.org/"
  pause
  exit /b 1
)

rem 1) electron package missing or a different version than package.json -> npm install
if not exist ".\node_modules\electron\package.json" goto npm
node -e "process.exit(require('./node_modules/electron/package.json').version===require('./package.json').devDependencies.electron?0:1)" >nul 2>&1
if errorlevel 1 goto npm
goto ensure

:npm
echo.
echo [DownCat] Installing / updating Electron (about 1-3 minutes, once only)...
echo.
call npm install
if errorlevel 1 goto failed

:ensure
rem 2) Electron 40+ no longer downloads its program during npm install -> download it here.
rem    install.js exits right away when the matching version is already there.
node ".\node_modules\electron\install.js"
if errorlevel 1 goto failed
if not exist ".\node_modules\electron\dist\electron.exe" goto failed

:run
start "" ".\node_modules\electron\dist\electron.exe" .
exit /b 0

:failed
echo.
echo [DownCat] Install failed. Check your internet connection and run this file again.
echo   (or open this folder in a terminal and run: npm install  then  npx install-electron --no)
echo.
pause
exit /b 1
