@echo off
chcp 65001 >nul
setlocal
rem 관리자 권한이 없으면 자기 자신을 관리자로 다시 실행(UAC 1회)
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo 관리자 권한이 필요합니다. 동의 창이 뜨면 "예"를 눌러주세요...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
pushd "%~dp0"
echo.
echo [받냥이] 크롬/엣지 확장 자동설치 정책을 제거합니다...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\downcat-ext-policy.ps1" -Uninstall
echo.
echo 끝났습니다. 크롬/엣지를 다시 켜면 확장이 사라집니다.
echo.
pause
