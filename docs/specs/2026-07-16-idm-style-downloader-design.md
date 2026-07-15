# 받냥이 IDM화 기획서 — 가속 다운로드 + 브라우저 캡처 + 동영상 그랩

작성: 2026-07-16 · 대상: `C:\Users\rkdtk\downcat` (받냥이 확장) · 기반: IDM 6.43 구조 분석 + FileCentipede 비교(§10 반영)

---

## 0. 한 줄 요약

받냥이에 **IDM의 핵심 두 개**를 붙인다: ① `aria2`로 일반 파일을 여러 조각 병렬로 빠르게 받기, ② 브라우저 확장으로 "지금 보는 페이지의 파일·동영상"을 쿠키·referer까지 통째로 잡아 받냥이에 원클릭 전달. 동영상 스트림은 기존 `yt-dlp`가 처리.

📌 쉽게: IDM은 "빠른 다운로드 엔진 + 브라우저서 낚아채기" 딱 두 개가 본질이야. 둘 다 이미 공개 도구(aria2, yt-dlp)로 풀린 문제라 **받냥이가 그걸 감싸기만** 하면 돼. 밑바닥부터 만들 필요 없음.

---

## 1. IDM 구조 분석 결과 (근거)

`idman643build5.exe` = 12MB 정품 설치본(Tonec 서명 유효, v6.43 build 5).
- 구조: x86 스텁 설치기(110KB) + 압축된 12MB 페이로드.
- 페이로드에서 꺼낸 실물: `components2\idmcchandler2_64.dll` = **Chrome 네이티브 메시징 핸들러**. → 확장이 이 다리로 엔진과 대화하는 구조 확정.

IDM 아키텍처(분석 + 공개 동작):

| 부품 | 역할 | 받냥이에서 대응 |
|---|---|---|
| `IDMan.exe` 엔진 | 파일을 최대 32조각 `Range` 병렬 요청 후 재조립(가속), 일시정지·재개 | **aria2c.exe 래핑** (16연결 분할·재개 내장) |
| 브라우저 확장 | `webRequest`/`downloads` 후킹, 다운로드·동영상 URL 가로챔 | **새 MV3 확장** |
| `idmcchandler2_64.dll` | 확장↔엔진 다리. URL+쿠키+referer+UA 전달 | **로컬 HTTP 브리지** (127.0.0.1) |
| 비디오 그래버 | HLS/DASH 감지→조각 받아 mux | **yt-dlp** (이미 있음) |

**핵심 통찰**: IDM이 인증·로그인 필요한 파일도 받는 비결은 "브라우저의 쿠키·referer·UA를 그대로 엔진에 넘기기". 받냥이는 이 배관(cookies.txt export, `--referer`)이 **이미 있음** → 확장이 값만 넘기면 재사용.

---

## 2. 목표 / 비목표

**목표 (1차)**
1. 일반 파일 URL을 aria2로 다중 연결 가속 다운로드 (일시정지·재개 포함).
2. 브라우저 확장: 현재 탭에서 클릭한 파일/링크를 쿠키·referer·UA와 함께 받냥이로 전달.
3. 확장: 페이지 내 동영상 스트림(HLS/DASH/mp4) 감지 → 원클릭으로 받냥이(yt-dlp)에 전달.
4. Chrome·Edge 지원(같은 Chromium 확장 하나로).

**비목표 (YAGNI — 지금 안 함)**
- IDM식 32세그먼트 정밀 튜닝/자체 세그먼트 엔진 (aria2 기본값이면 충분).
- 스케줄러, 대역폭 시간대별 제한, 사이트 그래버 규칙 편집기.
- 셸(우클릭 메뉴)·클립보드 확장자 가로채기 (받냥이 클립보드 감시로 대체 가능).
- Firefox 확장 (Chromium 먼저, 나중에 얇은 델타로).
- FTP/BitTorrent 풀 클라이언트·시드(개인용 범위 밖). 단 **magnet 붙여넣기 다운로드는 aria2가 공짜로 지원** → 선택적 M5로 뺌(§8).

---

## 3. 아키텍처

```
[브라우저 탭]
   │ (a) 다운로드 클릭 가로채기  (b) 동영상 스트림 감지
   ▼
[MV3 확장]  ── background.js: webRequest로 미디어 URL 수집, downloads로 파일 가로채기
   │          쿠키(chrome.cookies) + referer + User-Agent 수집
   │  POST http://127.0.0.1:47653/add  { url, referer, ua, cookies, kind, token }
   ▼
[받냥이 main.js 안의 로컬 브리지 서버]  ── 127.0.0.1 전용, 토큰 검사
   │  받은 job을 렌더러 큐에 추가 (기존 download IPC 재사용)
   ▼
[engine.js pickTool()]  ── kind/URL 보고 라우팅
   ├─ 일반 파일  → aria2.js (aria2c.exe, 다중연결)
   ├─ 동영상/모르는 곳 → yt-dlp (기존)
   └─ 이미지 갤러리 → gallery-dl (기존)
```

📌 다리를 왜 **네이티브 메시징 대신 로컬 HTTP**로? 네이티브 메시징은 윈도우 레지스트리에 호스트 등록 + 매니페스트 경로 문제 + 이미 떠 있는 GUI 프로세스에 닿기 어려움. 127.0.0.1 루프백 HTTP는 등록 없이 바로 되고, 확장 여럿·재시작에도 안정적. IDM도 "엔진이 떠 있어야 확장이 됨"이라 조건 동일.

---

## 4. 컴포넌트 상세 (무엇 / 어떻게 / 의존)

### 4.1 `aria2.js` — 가속 다운로드 래퍼 (신규)
- **무엇**: 파일 URL 하나를 aria2c로 다중 연결 다운로드하고 진행률을 이벤트로 흘림. 받냥이 다른 엔진과 같은 `onEvent({type,percent,speed,eta,...})` 계약 준수.
- **어떻게**: `bin/aria2c.exe`를 `spawn`. 인자 예:
  `-x16 -s16 -k1M --continue=true --dir=<outDir> --console-log-level=warn --summary-interval=1 --header=Referer:<r> --header=User-Agent:<ua> --load-cookies=<cookies.txt> <url>`
  stdout에서 `[#gid ... (NN%) ... DL:5.0MiB]` 줄 정규식으로 percent·speed 뽑아 `progress` 이벤트.
- **의존**: `bin/aria2c.exe` (없으면 자동설치 안내 — ffmpeg 자동설치 패턴 그대로 재사용). `Range` 미지원 서버면 aria2가 자동으로 단일 연결로 폴백.
- **일시정지·재개**: `--continue`로 재개는 공짜. 일시정지는 1차엔 "취소=프로세스 중단, 재개=같은 URL 다시(이어받음)"로 단순화. 진짜 pause는 aria2 RPC 데몬 모드가 필요 → 2차.

### 4.2 로컬 브리지 서버 (main.js에 추가, 신규)
- **무엇**: 확장이 job을 던지는 창구. 받으면 렌더러에 "URL 자동 추가" 이벤트를 보냄(기존 `clipboard-url` 채널과 동일 흐름).
- **어떻게**: Electron `app.whenReady` 시 `http.createServer`로 `127.0.0.1:47653`(고정 포트) 바인딩. `POST /add` JSON 수신. `X-Downcat-Token` 헤더가 저장된 토큰과 다르면 403.
- **보안**: 루프백 전용 바인딩(외부 접근 불가) + 랜덤 토큰(설치 시 생성, 확장 옵션에 붙여넣기 or 최초 페어링). CORS는 확장 origin만 허용. Private Network Access(PNA) 프리플라이트도 확장 origin만 통과.
- **의존**: Node 내장 `http`. 새 npm 의존 없음.

> **보안 트레이드오프 (FileCentipede·IDM 대비)**: FC와 IDM은 **네이티브 메시징**을 쓴다 — 열린 포트가 없어 로컬 다른 프로세스가 job을 못 던진다(더 안전). 로컬 HTTP는 포트가 열려 있어, 토큰이 없으면 로컬 악성 프로세스가 job을 넣을 수 있다. 개인용 + 토큰 + 루프백이면 실질 위험은 낮다고 판단해 **1차는 로컬 HTTP(단순)**. 나중에 강화가 필요하면 **네이티브 메시징 호스트(작은 stub이 명명 파이프로 실행 중 Electron에 전달)** 로 승격 — IDM의 `idmcchandler` 구조 그대로. 포트를 아예 안 여는 방식이라 가장 안전. (ponytail: 지금 필요 없는 배관은 안 만든다. 승격 경로만 명시.)

### 4.3 브라우저 확장 `extension/` (신규, MV3)
- **파일**: `manifest.json`, `background.js`(service worker), `popup.html`/`popup.js`, `options.html`(토큰·포트 설정), `content.js`(동영상 감지 배지).
- **다운로드 가로채기**: `chrome.downloads.onDeterminingFilename` 또는 우클릭 컨텍스트 메뉴("받냥이로 받기"). 가로챈 URL + `chrome.cookies.getAll(domain)` + 탭 referer + navigator UA를 브리지로 POST. (자동 가로채기는 기본 OFF, 컨텍스트 메뉴가 기본 — 브라우저 기본 다운로드와 안 싸우게.)
- **동영상 감지**: `chrome.webRequest.onBeforeRequest`로 `.m3u8`/`.mpd`/`.mp4` 요청 수집 → 팝업/배지에 "이 동영상 받기" 목록. 클릭 시 그 페이지 URL(또는 스트림 URL)을 브리지로 전달, 받냥이가 yt-dlp로 처리.
- **리소스 수집기 패널 (FileCentipede 벤치마크 — IDM보다 나은 부분)**: 팝업에 현재 페이지의 **미디어·이미지·오디오 목록**을 훑어 체크박스로 보여주고, 고른 것만 일괄 전달. 종류별로 알아서 라우팅 — 이미지 다수면 gallery-dl, 동영상이면 yt-dlp, 직링 파일이면 aria2. IDM의 "링크 전부 받기"보다 종류 인식·미리보기가 있어 정확. content.js가 `<img>/<video>/<audio>/<source>` DOM + webRequest 수집분을 합쳐 background에 보고.
- **권한**: `downloads`, `cookies`, `webRequest`, `contextMenus`, `<all_urls>`(host_permissions). 최소로.
- **의존**: 브리지 서버가 떠 있어야 함(받냥이 실행 중). 안 뜨면 "받냥이를 켜주세요" 안내.

### 4.4 `engine.js` 라우팅 확장 (기존 수정, 작게)
- `pickTool(url, mode, kind)`에 `aria2` 분기 추가: 확장이 `kind:'file'`로 보냈거나 URL이 직접 파일(확장자 zip/exe/pdf/mp4직링 등)이고 미디어 사이트가 아니면 `aria2`.
- 나머지(mode video/auto, 미디어 사이트) 로직은 그대로. 최소 변경.

---

## 5. 데이터 흐름 (인증 다운로드 예시)

1. 사용자가 로그인된 사이트에서 "받냥이로 받기" 우클릭.
2. 확장이 `url` + 그 도메인 `cookies` + 탭 `referer` + `UA` 수집 → `POST /add`.
3. 브리지가 토큰 검증 후 렌더러에 job 추가. 렌더러가 임시 cookies.txt(그 job용) 생성.
4. `engine.download()` → `pickTool`이 `aria2` 선택 → `aria2.js`가 `--load-cookies --header=Referer --header=User-Agent`로 실행.
5. aria2가 16연결로 받음 → 진행률 이벤트가 기존 카드 UI에 그대로 표시.

📌 핵심: 받냥이의 쿠키·referer 배관이 이미 있어서, 확장은 "값 배달부"만 하면 됨.

---

## 6. 에러 처리

- `aria2c.exe` 없음 → ffmpeg처럼 "받냥이가 자동 설치" 버튼 + 실패 메시지(얼버무리지 않음).
- 서버가 `Range` 미지원 → aria2 단일 연결 자동 폴백(에러 아님).
- 브리지 포트 점유 → 앱 시작 시 로그 남기고 확장에 501 반환("포트 충돌, 설정에서 변경").
- 토큰 불일치 → 403 + 확장 옵션에서 재페어링 안내.
- 확장이 보냈는데 받냥이 꺼짐 → 확장이 연결 실패 감지 → "받냥이를 먼저 켜세요" 배지.

---

## 7. 테스트 (검증 사다리 준수)

- **aria2.js 유닛**: `test_engine.js` 방식으로, 가짜 stdout 줄을 넣어 진행률 파싱(정규식)이 맞는지 assert. (네트워크 안 탐 — 받냥이 주입 원칙.)
- **엔진 스모크**: 작은 공개 파일(예: 몇 MB 직링)로 `node engine.js <url>` 실제 다운로드 1회.
- **브리지**: `curl -X POST 127.0.0.1:47653/add` 로 토큰 검증·job 추가 확인.
- **GUI 스모크**: 기존 `DOWNCAT_SMOKE` 방식 유지, `__bridge__` 케이스 추가.
- **확장**: Chrome `chrome://extensions` 개발자 모드 로드 → 실제 페이지서 우클릭·동영상감지 수동 확인(자동화 어려움 — 수동 체크리스트 문서화).

---

## 8. 단계별 마일스톤

- **M1 — aria2 엔진**: `bin/aria2c.exe` 추가, `aria2.js` 래퍼, `pickTool` 분기, 유닛+스모크. (확장 없이 받냥이 창에 파일 직링 붙여넣어도 가속 다운로드 되게.)
- **M2 — 로컬 브리지**: main.js에 HTTP 서버 + 토큰 + 렌더러 job 추가. curl로 검증.
- **M3 — 확장(파일)**: MV3 뼈대, 컨텍스트 메뉴 "받냥이로 받기", 쿠키·referer·UA 배달. Chrome/Edge 로드 테스트.
- **M4 — 확장(동영상 + 리소스 수집기)**: webRequest 스트림 감지 + 팝업 "이 동영상 받기" + **리소스 수집기 패널**(미디어·이미지·오디오 일괄 선택, 종류별 라우팅).
- **M5 — 선택(공짜에 가까운 보너스)**: aria2가 이미 지원하는 **magnet 붙여넣기 다운로드** + **체크섬 검증**(`--checksum`, 페이지가 해시 줄 때). 필요할 때만.

각 마일스톤은 독립 검증 가능. M1만으로도 "빠른 다운로더"로 유용. M5는 언제든 뺄 수 있음(YAGNI).

---

## 9. 결정 확정 (2026-07-16 사용자 승인)

- ✅ 확장 다운로드 가로채기: **기본 OFF(우클릭 컨텍스트 메뉴)** — 브라우저 기본 다운로드와 충돌·놀람 방지.
- ✅ 브리지 포트: **47653 고정**.
- ✅ aria2 동시 연결: **16** (IDM 32는 서버 부담·차단 위험).

---

## 10. FileCentipede 비교 및 반영 (기획 고도화 근거)

FileCentipede(filecxx/FileCentipede) = C++/Qt + libtorrent 올인원 다운로더. HTTP(S)/FTP(S)/SFTP/BitTorrent/magnet/ed2k/m3u8/WebDAV 지원. **주의: "소스 공개"라지만 핵심 엔진 의존 라이브러리는 독점** → 코드 가져다 쓸 순 없고, 설계 아이디어만 참고.

| FC 기능 | IDM | 우리 결정 |
|---|---|---|
| CLI 백엔드로 **aria2/curl/wget/axel** 사용 | 자체 엔진 | ✅ **채택 근거 강화** — FC도 aria2 씀. 우리 aria2 래핑은 정석 |
| **리소스 수집기 패널**(미디어·이미지·오디오 일괄) | 링크 전부 받기(약함) | ✅ **채택** — M4에 반영. 종류 인식·미리보기로 더 정확 |
| 확장↔앱 = 네이티브 메시징(포트 안 엶) | 네이티브 메시징 | ⚠️ **트레이드오프 반영**(§4.2) — 1차 로컬 HTTP, 강화 시 네이티브 승격 |
| m3u8 **AES-128 복호화**(SAMPLE-AES 미지원) | 지원 | ✅ 이미 커버 — yt-dlp가 동일 처리(SAMPLE-AES 한계도 동일) |
| **magnet/torrent** 다운로드 | 없음 | ➕ **선택 M5** — aria2가 magnet 공짜 지원 |
| 체크섬 검증 | 일부 | ➕ **선택 M5** — aria2 `--checksum` |
| WebDAV/FTP/SSH 파일매니저·원격·시드박스 | 없음 | ❌ 개인용 범위 밖 |

**결론**: FC에서 가져올 진짜 개선은 딱 두 개 — ① **리소스 수집기 패널**(M4 승격), ② **네이티브 메시징 보안 승격 경로**(명시만, 구현은 나중). 나머지(magnet·체크섬)는 aria2 덕에 거의 공짜라 선택 M5로. 큰 그림(받냥이 + aria2 + yt-dlp + 확장)은 안 바뀜 — FC가 오히려 aria2 백엔드로 우리 방향을 검증해줌.
