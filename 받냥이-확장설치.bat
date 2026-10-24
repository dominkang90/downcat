@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "EXT=%~dp0extension"
if not exist "%EXT%\manifest.json" (
  echo [받냥이] 확장 폴더를 못 찾았어요: %EXT%
  pause
  exit /b 1
)

rem 개발자 배포판처럼 서명된 CRX(build\downcat-ext.crx)가 있을 때만 예전 자동설치(정책) 방식을 쓴다.
rem 소스 ZIP/깃 클론에는 CRX가 없다(서명키는 저장소에 안 올림) → 아래 "직접 로드" 방식.
if exist "build\downcat-ext.crx" goto policy

rem ── 직접 로드(개발자 모드) 도우미: 확장 폴더 주소 복사 + 확장 관리 화면 열기 ──
powershell -NoProfile -Command "Set-Clipboard -Value $env:EXT" >nul 2>&1

set "BROWSER="
for %%K in ("HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe") do (
  if not defined BROWSER reg query %%K >nul 2>&1 && set "BROWSER=chrome"
)
if not defined BROWSER (
  for %%K in ("HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe") do (
    if not defined BROWSER reg query %%K >nul 2>&1 && set "BROWSER=msedge"
  )
)
if "%BROWSER%"=="chrome" start "" chrome "chrome://extensions/"
if "%BROWSER%"=="msedge" start "" msedge "edge://extensions/"

echo.
echo ================== 받냥이 확장 설치 (약 1분) ==================
if defined BROWSER (
  echo  브라우저의 확장 관리 화면을 열었어요. 아래 3단계면 끝나요.
) else (
  echo  크롬 주소창에 chrome://extensions 를 입력해 확장 관리 화면을 여세요.
)
echo.
echo   1. 오른쪽 위 [개발자 모드] 스위치를 켜요.
echo   2. 왼쪽 위 [압축해제된 확장 프로그램 로드]를 눌러요.
echo   3. 폴더 고르는 창 맨 위 주소칸을 클릭 → Ctrl+V → Enter → [폴더 선택]
echo      (확장 폴더 주소는 이미 복사해 뒀어요)
echo      %EXT%
echo.
echo   설치되면 "연결 설정" 화면이 저절로 떠요.
echo   받냥이를 켜 둔 채 [연결하기] → 받냥이 창에서 [예]를 누르면 끝이에요.
echo.
echo   ※ 이 받냥이 폴더를 옮기거나 지우면 확장도 같이 사라져요.
echo ===============================================================
echo.
pause
exit /b 0

:policy
rem ── 예전 방식: 관리자 권한으로 크롬/엣지 강제설치 정책 등록 ──
net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo 관리자 권한이 필요해요. 뜨는 창에서 [예]를 눌러 주세요...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
echo.
echo [받냥이] 크롬/엣지 확장 자동설치 정책을 등록해요...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\downcat-ext-policy.ps1" -CrxPath "build\downcat-ext.crx" -ConfigPath "config.json"
echo.
echo 크롬/엣지를 완전히 끈 뒤 다시 켜면 설치돼요(툴바에 받냥이 아이콘).
echo ※ 회사 도메인에 묶이지 않은 개인 PC에서는 크롬이 스토어 밖 확장의 자동설치를 막을 수 있어요.
echo    그럴 땐 build\downcat-ext.crx 를 잠시 다른 곳으로 옮기고 이 파일을 다시 실행하세요(직접 로드 방식).
echo.
pause
