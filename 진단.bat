@echo off
cd /d "%~dp0"
echo [DownCat] Diagnostics running (about 1 minute)...
node ".\scripts\diag.js"
echo.
echo Done. Saved logs\diag.txt
timeout /t 5
