# 받냥이 (DownCat) 설계문서

날짜: 2026-07-07
목표: hitomi_downloader_GUI의 핵심 기능을 내 컴퓨터용 바탕화면 앱으로 다시 만든다.

## 한 줄 요약
URL을 붙여넣으면 영상이든 이미지든 알아서 폴더로 정리해 받아주는 바탕화면 창 앱.

## 핵심 통찰
원본(hitomi_downloader)도 속으로는 성숙한 도구들을 굴려서 "만능"이 된다.
그래서 스크래퍼 100개를 새로 짜지 않고, 검증된 두 도구를 감싼다:
- `yt-dlp` → 유튜브·틱톡·트위터 영상 등 영상 사이트 수백 개
- `gallery-dl` → 인스타·핀터레스트·픽시브·hitomi 등 이미지 갤러리 수백 개

## 구조
- **창(Electron)**: URL 입력 + 다운로드 버튼 + 작업 목록(진행률) + 저장폴더 설정 + 폴더 열기.
- **엔진(engine.js, Node 메인 프로세스)**: URL 라우팅 → 알맞은 도구를 자식 프로세스로 실행 → 출력 파싱 → IPC로 진행률 전송.
- **엔진은 CLI로도 실행 가능**(`node engine.js <url>`) → GUI 없이도 end-to-end 테스트 가능.

## URL 라우팅 (auto / 영상 / 이미지)
- auto: 도메인 맵으로 판단. 영상 도메인 → yt-dlp, 이미지 도메인 → gallery-dl.
- 모르는 도메인 → yt-dlp 우선(에러가 깔끔). 사용자가 모드 버튼으로 강제 가능.

## 폴더 정리
- `저장폴더/<사이트>/<업로더>/파일` 구조.
- yt-dlp: `-o "%(extractor)s/%(uploader)s/%(title)s [%(id)s].%(ext)s"`
- gallery-dl: `-d <저장폴더>` (extractor 기본 디렉터리 구조 사용).

## 작업 목록 저장
- `tasks.json`에 기록. (원본 SQLite는 과함 — 안 씀. ponytail: 수천 건 넘으면 SQLite로.)

## 엔진 자동 준비
- 첫 실행 시 `bin/yt-dlp.exe` 자동 다운로드(github latest release).
- `gallery-dl`은 `pip install gallery-dl`.
- `ffmpeg`는 화질 병합용(선택). v1 기본 포맷은 단일 mp4(`best[ext=mp4]/best`)라 ffmpeg 없어도 동작.

## 끝까지 테스트 (end-to-end 성공 기준)
1. 공개 유튜브 영상 1개 URL → mp4 파일이 `저장폴더/youtube/...`에 떨어진다.
2. 로그인 불필요한 이미지 URL 1개 → 이미지 파일이 폴더에 떨어진다.
3. Electron 창이 뜨고, 입력→다운로드→진행률→완료가 눈으로 보인다.
- ⚠️ 인스타는 대부분 로그인(쿠키) 필요. 기능·쿠키칸은 넣되 자동 테스트는 로그인 불필요 대상으로.

## 안 만드는 것 (YAGNI)
사이트별 개별 스크래퍼, 예약 다운로드, 계정 관리, SQLite, 멀티 프로필.
