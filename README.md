# 🐾 받냥이 (DownCat)

URL을 붙여넣으면 영상·이미지를 알아서 폴더로 정리해 받아주는 바탕화면 다운로더.
(hitomi_downloader의 핵심 기능을 내 컴퓨터용으로 다시 만든 것.)

## 어떻게 만능인가
스크래퍼를 직접 안 짜고, 검증된 두 도구를 감싼다:
- **yt-dlp** → 유튜브·틱톡·트위터 영상 등 영상 사이트 수백 개
- **gallery-dl** → 인스타·핀터레스트·픽시브·imgur·hitomi 등 이미지 갤러리 수백 개

`auto` 모드는 링크 도메인을 보고 둘 중 알맞은 도구로 넘긴다.

## 실행
- **`받냥이.bat` 더블클릭** (또는 `npm start`)
- URL 붙여넣고 [다운로드]. 저장 폴더는 창에서 바꿀 수 있다.

## 처음 한 번 준비
- `npm install` (electron 설치)
- `bin/yt-dlp.exe` 자동/수동 배치, `pip install gallery-dl`
- (선택) `bin/ffmpeg.exe` 넣으면 유튜브 고화질 영상+소리 합치기 자동 사용

## 인스타그램
요즘 인스타는 대부분 로그인이 필요하다. 로그인된 브라우저의 쿠키를 gallery-dl에
물려야 받아진다. (다음 개선 항목)

## 구조
- `engine.js` — URL 라우팅 + 도구 실행 + 진행률 파싱 (터미널에서도 `node engine.js <URL>` 실행 가능)
- `main.js` / `preload.js` — Electron 메인 + 안전한 IPC 다리
- `index.html` / `renderer.js` / `styles.css` — 창 UI
- `tasks.json` — 작업 기록, `config.json` — 저장 폴더 설정
