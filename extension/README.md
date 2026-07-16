# 받냥이 확장 (단독 설치 안내)

이 확장은 **받냥이 앱이 켜져 있어야** 동작합니다(브라우저에서 잡은 URL·쿠키를 받냥이 로컬 브리지 `127.0.0.1:47653`로 보냄). 확장만으로는 다운로드가 안 됩니다.

## 방법 A — 자동 설치 (관리자 권한 1회, 추천)
크롬/엣지에 정책으로 자동 설치됩니다.
1. `받냥이-확장설치.bat` 더블클릭 → UAC "예".
2. 크롬/엣지 완전 종료 후 다시 켜기 → 툴바에 받냥이 아이콘.
3. 토큰은 자동(managed 정책). 팝업이 "받냥이 연결됨 ✅"이면 끝.
- 되돌리기: `받냥이-확장제거.bat`.
- 필요한 파일: `downcat-ext.crx`, `scripts/downcat-ext-policy.ps1`, (있으면) `config.json`.

## 방법 B — 수동 로드 (권한 없이, 개발자모드)
1. 크롬 `chrome://extensions` (엣지 `edge://extensions`) → **개발자 모드** 켜기.
2. **"압축해제된 확장 프로그램 로드"** → 이 `extension` 폴더 선택.
3. 확장 옵션에서 받냥이 토큰 붙여넣기(`config.json`의 `bridgeToken`).
   - PowerShell: `(Get-Content config.json -Raw | ConvertFrom-Json).bridgeToken`

## 쓰는 법
- 링크·이미지·영상 위 우클릭 → **"받냥이로 받기"**.
- 툴바 아이콘 → 팝업에서 이 페이지의 동영상·이미지 목록을 골라 일괄 전송(리소스 수집기).

확장 ID: `hcaehgnpahddjceeamipjimeokagpgno`
