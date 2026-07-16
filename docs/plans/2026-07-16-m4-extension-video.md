# M4 — 확장(동영상 스트림 감지 + 리소스 수집기) 구현 기록

> 기반: `docs/specs/2026-07-16-idm-style-downloader-design.md` §4.3, §8(M4), §10(FileCentipede 리소스 수집기 벤치마크)
> 코드 착수 전 `andrej-karpathy-guidelines` 스킬 호출함(CLAUDE.md 규칙).

**Goal:** 브라우저 툴바 팝업에 **"이 페이지의 미디어" 목록**을 띄운다 — 재생 중 잡힌 동영상 스트림(m3u8/mpd) + 페이지의 이미지·오디오를 체크박스로 골라 **일괄** 받냥이로 보낸다. 종류별로 알아서 라우팅.

**핵심:** M4는 **순수 확장 변경**. downcat 쪽(bridge/main/engine) 손 안 댐 — 스트림은 `mode:'video'`(yt-dlp), 직링은 `mode:'file'`(aria2)로 보내면 M3에서 뚫린 배관(쿠키·referer·UA)을 그대로 탄다.

## 구현 요약

| 파일 | 변경 |
|---|---|
| `extension/manifest.json` | 권한 추가: `webRequest`(스트림 감지), `scripting`(DOM 긁기), `tabs` |
| `extension/background.js` | `chrome.webRequest.onBeforeRequest`가 탭마다 미디어 URL 수집(`classifyUrl`: m3u8/mpd/m4s→stream, mp4류→video, mp3류→audio). 페이지 이동/탭 닫힘 시 초기화. `getStreams` 메시지로 팝업에 전달 |
| `extension/popup.html/js` | **리소스 수집기 패널** — `getStreams`(webRequest) + `scrapeDom`(scripting으로 `<img>/<video>/<audio>/<source>` 긁기) 합쳐 중복제거 → 종류별 체크박스 목록. 전체선택/해제/새로고침. "선택한 것 보내기"가 종류별 모드로 일괄 전송 |

## 라우팅 규칙 (팝업 → 브리지)

- 스트림(`.m3u8/.mpd/.m4s`) → `mode:'video'` (yt-dlp가 조각 조립·mux)
- 직링 동영상·오디오·이미지 → `mode:'file'` (aria2 직접 가속 다운로드)
- 전송은 M3의 `sendToDowncat` 재사용 → 쿠키(`chrome.cookies.getAll(리소스URL)`)·referer(탭 URL)·UA 자동 첨부

## 자동 검증 (완료)

- `node --check` — background/popup/options + manifest JSON 전부 통과.
- 라우팅 regex 오프라인 새니티: `classifyUrl`(stream/video/audio/null)·`modeFor`(스트림→video, 직링→file) 샘플 URL 검증.
- downcat 회귀: `test_bridge/engine/aria2.js` 통과(mode:'video' 파싱은 test_bridge가 이미 커버).

## 수동 검증 체크리스트 (브라우저)

1. **확장 갱신**: `chrome://extensions`에서 받냥이 확장 **새로고침**(권한 webRequest/scripting/tabs 추가됨 → 다시 로드).
2. **스트림 감지**: HLS 동영상 페이지(예: m3u8 쓰는 사이트)에서 **재생 시작** → 팝업 열기 → 목록에 🎬 스트림이 뜨는지. (재생 전엔 안 잡힐 수 있음 → 재생 후 새로고침.)
3. **이미지·미디어 목록**: 이미지 많은 페이지에서 팝업 → 🖼️ 이미지들이 뜨는지. 전체선택/해제 동작.
4. **일괄 전송**: 몇 개 체크 → "선택한 것 보내기" → 받냥이 창에 카드 여러 개 뜨고 각각 받아지는지(스트림=yt-dlp, 직링=aria2).
5. **특수 페이지**: `chrome://` 등에선 목록이 "감지된 미디어 없음"으로 조용히 처리되는지(주입 실패 무시).

## 알려진 한계 (ponytail)

- 서비스워커가 잠들면 수집 목록(메모리 Map)이 비워짐 — 페이지 재생하면 다시 잡히니 감수. 필요하면 `chrome.storage.session`으로 승격.
- blob:/data: 미디어(일부 플레이어)는 http(s)가 아니라 목록에서 제외 — yt-dlp가 페이지 URL로 잡는 편이 나음("이 페이지 보내기" 사용).

## 범위 밖(다음)

- **M5(선택)**: magnet 붙여넣기(aria2 공짜 지원) + 체크섬 검증(`--checksum`).
- Origin 허용목록을 실제 확장 ID로 좁히기(스토어 등록 후).
- 스트림 감지 개수를 툴바 배지로 표시(IDM식 신호).
