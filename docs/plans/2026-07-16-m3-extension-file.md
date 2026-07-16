# M3 — 브라우저 확장(파일 다운로드) 구현 기록

> 기반: `docs/specs/2026-07-16-idm-style-downloader-design.md` §4.3, §5, §8(M3)
> 코드 착수 전 `andrej-karpathy-guidelines` 스킬 호출함(CLAUDE.md 규칙).

**Goal:** 브라우저에서 링크·이미지·영상 위 우클릭 **"받냥이로 받기"** → 그 사이트의 **쿠키 + referer + User-Agent**를 함께 받냥이 브리지로 보내고, 받냥이가 aria2로 (로그인 필요한 파일도) 받는다. Chrome·Edge 공용 MV3 확장 하나.

**핵심 재사용:** 쿠키 전달 배관을 새로 안 만든다 — main.js의 기존 `netscapeLine()`(Electron 세션 쿠키를 cookies.txt로 굽던 함수)이 `chrome.cookies` 객체와 **같은 필드**라 그대로 재사용. 엔진의 `cookieFile`·`referer`·(aria2)`userAgent` 지원도 이미 있어 값만 흘려보냄.

## 구현 요약 (실제 변경)

| 파일 | 변경 |
|---|---|
| `bridge.js` | `parseAddBody`가 `cookies`(배열)·`userAgent`(≤512자)·`mode:'file'` 추가로 파싱. `sanitizeCookies()`가 이름·값·도메인 문자열인 쿠키만(최대 500개) 통과 |
| `engine.js` | `ytdlpArgs`에 `--user-agent`(있을 때만) 한 줄 — UA가 aria2뿐 아니라 yt-dlp 경로에도 붙게 |
| `main.js` | download 핸들러: `extra.cookies`가 있으면 이 작업용 임시 `downcat-ck-<id>.txt`를 `netscapeLine`으로 굽고 `cookieFile`로 넘김, `userAgent`도 전달, **`finally`에서 임시 쿠키파일 삭제**(민감) |
| `renderer.js` | `onBridgeJob`가 referer뿐 아니라 `userAgent`·`cookies`도 `extra`에 실어 download IPC로 |
| `test_bridge.js` | `mode:'file'`·userAgent 길이·쿠키 sanitize 케이스 추가 |
| `extension/` (신규) | `manifest.json`(MV3), `background.js`(우클릭 메뉴+전송), `options.html/js`(토큰 저장·`/ping` 확인), `popup.html/js`(연결 상태·이 페이지 보내기) |

## 전송 계약 (확장 → 브리지)

```
POST http://127.0.0.1:47653/add
헤더: X-Downcat-Token: <옵션에 저장한 토큰>
본문: { url, mode, referer?, userAgent?, cookies: [chrome.cookies.getAll 결과] }
```
- 링크 우클릭 → `mode:'file'`(aria2 가속). 이미지/영상/오디오 → `mode:'auto'`(엔진이 판단: 직링→aria2, m3u8→yt-dlp).
- 쿠키는 **다운로드 URL 도메인** 것만(`chrome.cookies.getAll({url})`).

## 자동 검증 (완료)

- `node --check` — bridge/engine/main/renderer + extension 3개 JS + manifest JSON 전부 통과.
- `node test_bridge.js` — 파싱(쿠키·UA·mode:file) + http 보안 게이트 통과.
- `node test_engine.js`, `node test_aria2.js` — 회귀 통과.
- 순수 스모크: bridge 파싱 → `netscapeLine`으로 cookies.txt 굽기(세션 쿠키 포함) 형식 검증.
- **Electron 종단 스모크**: 앱 실행 → 쿠키·UA·referer 실은 `POST /add`(mode:file) → **200 + 2.5MB 다운로드 성공 + 임시 쿠키파일 0개 남음**(finally 정리 확인).

## 수동 검증 체크리스트 (브라우저 — 자동화 불가)

1. **확장 로드**: Chrome/Edge `chrome://extensions` → 개발자 모드 ON → "압축해제된 확장 프로그램 로드" → `C:\Users\rkdtk\downcat\extension` 선택. 오류 없이 로드되는지.
2. **토큰 페어링**: 받냥이 실행 → `config.json`의 `bridgeToken` 복사(`(Get-Content config.json -Raw | ConvertFrom-Json).bridgeToken`) → 확장 옵션에 붙여넣기 → **저장** → **연결 확인**이 "받냥이와 연결됨 ✅"인지.
3. **파일 우클릭**: 아무 사이트의 파일 링크(zip/pdf 등) 우클릭 → "받냥이로 받기" → 툴바 배지 ✓ + 받냥이 창에 카드 뜨고 다운로드되는지.
4. **로그인 필요 파일(핵심)**: 로그인된 사이트에서 첨부/파일 링크 우클릭 → 받냥이가 브라우저 쿠키로 그 파일을 받는지(재로그인 없이).
5. **받냥이 꺼짐**: 받냥이 끄고 우클릭 전송 → 배지에 "받냥이 먼저 켜세요" 안내인지.
6. **팝업**: 툴바 아이콘 → 연결 상태 표시 + "이 페이지 보내기"/"토큰 설정" 동작.

## 범위 밖(다음)

- **M4**: 동영상 스트림 감지(webRequest `.m3u8/.mpd`) + 팝업 "이 동영상 받기" + **리소스 수집기 패널**(이미지·미디어 일괄 선택, 종류별 라우팅).
- Origin 허용목록을 실제 확장 ID로 좁히기(지금은 토큰이 실질 게이트). 확장 ID는 스토어 등록/키 고정 후 확정 가능.
- 토큰을 받냥이 설정 창에 표시해 복사 쉽게(UX 개선, config.json 수동 복사 대체).
- 아이콘 리소스(현재 기본 아이콘).
