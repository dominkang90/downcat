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
echo [받냥이] 크롬/엣지 확장을 설치합니다...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\downcat-ext-policy.ps1" -CrxPath "build\downcat-ext.crx" -ConfigPath "config.json"
echo.
echo 끝났습니다. 크롬/엣지를 완전히 종료했다가 다시 켜면 확장이 자동으로 설치됩니다.
echo (툴바에 받냥이 아이콘이 생기면 성공)
echo.
pause
