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
rem 3) Let Electron's sandboxed helper processes read the Electron folder.
rem    Some folders (e.g. Downloads on some PCs) carry an AppContainer-only ACL, and Electron then
rem    stops right away with "Sandboxed processes cannot read ...\electron\dist". This grants read
rem    access to ALL APPLICATION PACKAGES (S-1-15-2-1) on that folder only. No admin rights needed.
if exist ".\node_modules\electron\dist" icacls ".\node_modules\electron\dist" /grant *S-1-15-2-1:(OI)(CI)(RX) /T /C /Q >nul 2>&1

rem 4) Launch. scripts\launch.js tries normal mode first; if the window dies before it appears
rem    (some new Windows builds), it retries in safer modes and remembers the one that works.
where node >nul 2>&1
if errorlevel 1 (
  start "" ".\node_modules\electron\dist\electron.exe" .
  exit /b 0
)
echo [DownCat] Starting...
node ".\scripts\launch.js"
if errorlevel 1 (
  echo.
  echo [DownCat] Could not open the window. Tell Claude: the logs folder has the details.
  echo.
  pause
  exit /b 1
)
exit /b 0

:failed
echo.
echo [DownCat] Install failed. Check your internet connection and run this file again.
echo   (or open this folder in a terminal and run: npm install  then  npx install-electron --no)
echo.
pause
exit /b 1
