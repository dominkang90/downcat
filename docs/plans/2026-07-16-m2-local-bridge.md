# M2 — 로컬 브리지 서버 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **코드 착수 전 반드시 `andrej-karpathy-skills:karpathy-guidelines` 스킬 호출** (CLAUDE.md 규칙).

**Goal:** 브라우저 확장(또는 curl)이 `POST http://127.0.0.1:47653/add`로 URL을 던지면, 받냥이 창에 카드가 뜨고 다운로드된다(referer 함께 전달). 토큰으로 보호되는 루프백 전용 서버.

**Architecture:** 새 `bridge.js`가 `127.0.0.1:47653`에 HTTP 서버를 연다(토큰 검사, CORS, `/ping`, `/add`). `main.js`가 앱 시작 시 서버를 띄우고, 유효한 `/add` job을 기존 `clipboard-url`과 같은 방식으로 렌더러에 보낸다. 렌더러는 URL을 큐에 넣고 referer를 `download` IPC로 넘긴다 — `engine.js`는 referer를 이미 지원하므로 손대지 않는다. 쿠키·User-Agent 전달은 M3(확장)로 미룬다.

**Tech Stack:** Node 내장 `http`/`crypto`, Electron IPC. 새 npm 의존 없음.

## Global Constraints

- 새 npm 의존성 추가 금지. Node 내장 모듈만.
- 포트 **47653 고정**, 바인딩은 **`127.0.0.1` 전용**(외부 접근 불가 — 보안 핵심, 절대 `0.0.0.0` 금지).
- `POST /add`는 **토큰 필수**(`X-Downcat-Token` 헤더가 `settings.bridgeToken`과 다르면 403). 브라우저 요청은 **Origin이 `chrome-extension://`일 때만** CORS 허용(curl 등 Origin 없는 클라이언트는 허용). 본문 상한 **64KB**. 허용 라우트는 `GET /ping`·`POST /add`·`OPTIONS`뿐, 그 외 404.
- 브리지 job은 기존 `clipboard-url`과 동일 흐름으로 렌더러에 전달(카드 UI 재사용). 창이 없으면 `/add`는 503.
- 전달 값: `url`(필수, http/https), `mode`(video/image/auto, 기본 auto), `referer`(선택, http/https). **쿠키·User-Agent는 M2 범위 밖**(M3).
- `settings.bridgeToken`은 첫 실행 시 생성해 `config.json`에 저장(설치별 비밀, config.json은 gitignore됨).
- 기존 `download` IPC·렌더러 큐를 재사용 — 새 다운로드 경로를 만들지 말 것.
- 커밋 작성자: `git -c user.name=rkdtk -c user.email=rkdtkdwhd@gmail.com commit`. 병합·푸시는 마지막에 컨트롤러가(태스크에선 로컬 커밋만, 브랜치 유지).
- 의도적 단순화엔 `ponytail:` 주석. 한국어 쉬운 주석 + 코드엔 "📌 이 코드가 하는 일:" 설명.

---

### Task 1: `bridge.js` 순수 함수 (요청 파싱 + Origin 검사)

**Files:**
- Create: `bridge.js`
- Test: `test_bridge.js`

**Interfaces:**
- Produces:
  - `parseAddBody(raw: string) -> {job: {url, mode, referer?}} | {error: string}`
  - `isAllowedOrigin(origin: string|undefined) -> boolean`

- [ ] **Step 1: 실패하는 테스트 작성** — `test_bridge.js` 생성

```js
'use strict';
const assert = require('assert');
const { parseAddBody, isAllowedOrigin } = require('./bridge');

// 1) 정상 body: url + mode + referer
let r = parseAddBody(JSON.stringify({ url: 'https://ex.com/a.zip', mode: 'auto', referer: 'https://ex.com/' }));
assert.deepStrictEqual(r.job, { url: 'https://ex.com/a.zip', mode: 'auto', referer: 'https://ex.com/' });

// 2) mode 생략 → auto, referer 생략 → 키 없음
r = parseAddBody(JSON.stringify({ url: 'https://ex.com/a.zip' }));
assert.strictEqual(r.job.mode, 'auto');
assert.strictEqual('referer' in r.job, false);

// 3) mode 이상값 → auto로 정규화
assert.strictEqual(parseAddBody(JSON.stringify({ url: 'https://ex.com/a', mode: 'wat' })).job.mode, 'auto');
assert.strictEqual(parseAddBody(JSON.stringify({ url: 'https://ex.com/a', mode: 'video' })).job.mode, 'video');

// 4) 나쁜 입력 → error
assert(parseAddBody('{not json').error);
assert(parseAddBody(JSON.stringify({})).error);                       // url 없음
assert(parseAddBody(JSON.stringify({ url: 'ftp://x/y' })).error);     // http/https 아님
assert(parseAddBody(JSON.stringify({ url: 'not a url' })).error);

// 5) referer가 http(s) 아니면 무시(키 없음, 에러는 아님)
r = parseAddBody(JSON.stringify({ url: 'https://ex.com/a', referer: 'javascript:alert(1)' }));
assert.strictEqual('referer' in r.job, false);

// 6) Origin 검사: 확장만 허용, Origin 없으면(curl 등) 허용, 웹페이지 Origin 거부
assert.strictEqual(isAllowedOrigin('chrome-extension://abcd'), true);
assert.strictEqual(isAllowedOrigin(undefined), true);
assert.strictEqual(isAllowedOrigin('https://evil.com'), false);

console.log('ok - parseAddBody, isAllowedOrigin');
```

- [ ] **Step 2: 실패 확인**

Run: `node test_bridge.js`
Expected: FAIL — `Cannot find module './bridge'`

- [ ] **Step 3: 최소 구현** — `bridge.js` 생성 (순수 함수만, 서버는 다음 태스크)

```js
'use strict';
// 받냥이 로컬 브리지: 브라우저 확장이 던진 다운로드 요청을 받아 받냥이 창에 넘긴다.
// 127.0.0.1 전용 + 토큰으로 보호한다. 이 파일은 순수 함수(파싱·검사)와 서버 생성으로 나뉜다.
const http = require('http');

// /add 요청 본문(JSON 문자열)을 검사해 안전한 job으로 바꾼다. 순수 함수 — 테스트로 검증한다.
function parseAddBody(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return { error: 'JSON 파싱 실패' }; }
  if (!data || typeof data.url !== 'string') return { error: 'url 없음' };
  let u;
  try { u = new URL(data.url); } catch { return { error: 'url 형식 오류' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'http/https만 허용' };
  const job = { url: data.url, mode: (data.mode === 'video' || data.mode === 'image') ? data.mode : 'auto' };
  // referer는 http(s)일 때만 받는다(javascript: 같은 위험한 값 차단)
  if (typeof data.referer === 'string' && /^https?:\/\//i.test(data.referer)) job.referer = data.referer;
  return { job };
}

// 브라우저에서 온 요청이면 확장(chrome-extension://)만 허용. Origin이 없으면(curl 등 비브라우저) 허용.
function isAllowedOrigin(origin) {
  return !origin || origin.startsWith('chrome-extension://');
}

module.exports = { parseAddBody, isAllowedOrigin };
```

📌 이 코드가 하는 일: `parseAddBody`는 확장이 보낸 글자 덩어리(JSON)를 뜯어 "진짜 http 주소인지, 모드는 뭔지, referer는 안전한지"만 걸러 깨끗한 주문표(job)로 만든다. `isAllowedOrigin`은 "이 요청이 우리 확장에서 온 거냐"를 본다(curl 같은 건 통과, 낯선 웹사이트는 차단).

- [ ] **Step 4: 통과 확인**

Run: `node test_bridge.js`
Expected: PASS — `ok - parseAddBody, isAllowedOrigin`

- [ ] **Step 5: 커밋**

```bash
git add bridge.js test_bridge.js
git -c user.name=rkdtk -c user.email=rkdtkdwhd@gmail.com commit -m "feat(bridge): 요청 파싱+Origin 검사 순수함수와 유닛테스트"
```

---

### Task 2: `bridge.js` HTTP 서버 (`createBridgeServer`)

**Files:**
- Modify: `bridge.js` (`createBridgeServer` 추가 + export)

**Interfaces:**
- Consumes: `parseAddBody`, `isAllowedOrigin` (Task 1).
- Produces: `createBridgeServer({token: string, onJob: (job) => boolean}) -> http.Server`. `onJob`이 true를 반환하면 `/add`는 200, false면 503. 서버는 `127.0.0.1:47653`에 listen.

- [ ] **Step 1: 구현** — `bridge.js`의 `module.exports` **앞에** 추가

```js
const HOST = '127.0.0.1';   // 루프백 전용 — 외부에서 접근 불가(보안 핵심)
const PORT = 47653;
const MAX_BODY = 64 * 1024; // 본문 상한 64KB

// 확장이 던진 요청을 받는 서버를 만든다. onJob(job)이 창에 전달 성공하면 true.
function createBridgeServer({ token, onJob }) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    // 확장 요청이면 CORS 헤더를 붙인다(Private Network Access 프리플라이트 포함)
    const setCors = () => {
      if (origin && isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET');
        res.setHeader('Access-Control-Allow-Headers', 'content-type, x-downcat-token');
      }
    };
    const send = (code, obj) => { setCors(); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'OPTIONS') { setCors(); res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/ping') { send(200, { ok: true, app: 'downcat' }); return; }
    if (req.method === 'POST' && req.url === '/add') {
      if (origin && !isAllowedOrigin(origin)) { send(403, { ok: false, error: 'origin 거부' }); return; }
      if (req.headers['x-downcat-token'] !== token) { send(403, { ok: false, error: '토큰 불일치' }); return; }
      let body = ''; let tooBig = false;
      req.on('data', (c) => { body += c; if (body.length > MAX_BODY) { tooBig = true; req.destroy(); } });
      req.on('end', () => {
        if (tooBig) return;
        const parsed = parseAddBody(body);
        if (parsed.error) { send(400, { ok: false, error: parsed.error }); return; }
        const delivered = onJob(parsed.job);
        if (delivered) send(200, { ok: true }); else send(503, { ok: false, error: '받냥이 창이 준비 안 됨' });
      });
      return;
    }
    send(404, { ok: false, error: 'not found' });
  });
  // ponytail: 포트 점유 시 앱이 죽지 않게 에러만 로그(확장은 연결 실패로 감지). 재바인드는 안 함.
  server.on('error', (e) => console.error('[bridge] 포트 열기 실패:', e.message));
  server.listen(PORT, HOST);
  return server;
}
```

그리고 export 교체:
```js
module.exports = { parseAddBody, isAllowedOrigin, createBridgeServer };
```

📌 이 코드가 하는 일: 받냥이 안에 아주 작은 우체통(127.0.0.1:47653)을 연다. 확장이 여기로 편지(POST /add)를 넣되 **열쇠(토큰)**가 맞아야 접수하고, 맞으면 주문표를 창에 전달한다. `/ping`은 "받냥이 살아있어?" 확인용.

- [ ] **Step 2: 문법 확인**

Run: `node --check bridge.js`
Expected: 출력 없음.

- [ ] **Step 3: 서버 스모크 (curl)** — 임시 스니펫으로 서버를 띄우고 요청

Run (bash):
```bash
cd /c/Users/rkdtk/downcat
node -e "const {createBridgeServer}=require('./bridge'); const s=createBridgeServer({token:'T', onJob:j=>{console.log('JOB',JSON.stringify(j));return true;}}); setTimeout(()=>{s.close();process.exit(0)},4000);" &
sleep 1
echo '--- ping (토큰 불필요) ---';        curl -s http://127.0.0.1:47653/ping
echo; echo '--- add 토큰 없음 → 403 ---';  curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:47653/add -d '{"url":"https://ex.com/a.zip"}'
echo '--- add 토큰 맞음 → 200 + JOB 출력 ---'; curl -s -w ' [%{http_code}]\n' -X POST http://127.0.0.1:47653/add -H 'X-Downcat-Token: T' -d '{"url":"https://ex.com/a.zip","referer":"https://ex.com/"}'
echo '--- 잘못된 메서드/경로 → 404 ---';    curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:47653/nope
wait
```
Expected: `/ping` → `{"ok":true,"app":"downcat"}`; 토큰 없는 add → `403`; 토큰 맞는 add → 콘솔에 `JOB {"url":"https://ex.com/a.zip","mode":"auto","referer":"https://ex.com/"}` + `[200]`; 이상 경로 → `404`.

- [ ] **Step 4: 외부 접근 차단 확인 (보안)** — 루프백 바인딩 검증

Run (bash): 위 스니펫이 떠 있는 동안
```bash
node -e "console.log(require('net').isIP('127.0.0.1')?'ok':'no')"  # (sanity)
```
그리고 서버 코드가 `server.listen(PORT, HOST)`에서 `HOST==='127.0.0.1'`임을 diff로 확인(0.0.0.0 아님).
Expected: `listen`의 두 번째 인자가 `'127.0.0.1'`.

- [ ] **Step 5: 커밋**

```bash
git add bridge.js
git -c user.name=rkdtk -c user.email=rkdtkdwhd@gmail.com commit -m "feat(bridge): 127.0.0.1:47653 토큰 보호 HTTP 서버 + curl 스모크"
```

---

### Task 3: `main.js` 통합 (토큰 생성 · 서버 기동 · job 전달 · download referer)

**Files:**
- Modify: `main.js`

**Interfaces:**
- Consumes: `createBridgeServer` (Task 2).
- Produces: 앱 시작 시 브리지 서버 기동. 유효한 job → `mainWin.webContents.send('bridge-job', job)`. `download` IPC가 `extra.referer`를 엔진에 전달.

- [ ] **Step 1: 토큰 생성** — `main.js`에서 `let settings = ...`(대략 33행) **다음 줄**에 추가

```js
// 브리지 토큰: 설치별 비밀. 첫 실행 때 만들어 config.json에 저장(gitignore됨). 확장 옵션에 붙여넣어 짝을 맞춘다.
if (!settings.bridgeToken) { settings.bridgeToken = require('crypto').randomBytes(24).toString('hex'); saveCfg(); }
let bridgeServer = null;
```

- [ ] **Step 2: 서버 기동/종료** — `app.whenReady().then(() => { ... })`(대략 71–75행) 안, `startClipboardWatch();` **다음 줄**에 추가

```js
  // 로컬 브리지: 확장이 던진 URL을 clipboard-url과 같은 방식으로 창에 넣는다.
  bridgeServer = require('./bridge').createBridgeServer({
    token: settings.bridgeToken,
    onJob: (job) => {
      if (!mainWin || mainWin.isDestroyed()) return false; // 창 없으면 503
      mainWin.webContents.send('bridge-job', job);
      return true;
    },
  });
```

그리고 `app.on('before-quit', ...)`(대략 79행)의 콜백 안에 서버 종료 추가:

```js
app.on('before-quit', () => { for (const id in jobs) jobs[id].abort(); if (bridgeServer) bridgeServer.close(); });
```

- [ ] **Step 3: download IPC에 referer 전달** — `download` 핸들러(대략 254행)의 구조분해와 `engine.download` 호출을 수정

핸들러 시그니처에 `extra` 추가:
```js
ipcMain.handle('download', async (e, { jobId, url, mode, useCookie, thumbnail, extra }) => {
```
`engine.download(url, { ... })` 옵션 객체에 referer 한 줄 추가(대략 261–264행):
```js
    result = await engine.download(url, {
      outDir: settings.outDir, mode,
      cookieFile: useCookie ? settings.cookieFile : null,
      referer: extra && extra.referer,   // 브리지(확장)가 준 referer — 엔진이 이미 지원
      thumbnail, ytHeight: settings.ytHeight, stories: settings.stories, rateLimit: settings.rateLimit,
      signal: ac.signal,
    }, send);
```

📌 이 코드가 하는 일: 받냥이가 켜질 때 우체통 서버를 열고, 편지가 오면 클립보드 자동추가와 똑같이 창에 URL을 넣는다. 확장이 준 referer는 다운로드에 그대로 실어 보낸다(핫링크 막힌 파일도 받게).

- [ ] **Step 4: 문법 확인**

Run: `node --check main.js`
Expected: 출력 없음.

- [ ] **Step 5: 실행 중 앱에 curl 스모크 (토큰 검사)** — 실제 앱을 띄우고 토큰으로 검증

Run (PowerShell, 앱을 백그라운드로 띄움):
```powershell
$tok = (Get-Content C:\Users\rkdtk\downcat\config.json -Raw | ConvertFrom-Json).bridgeToken
Start-Process -FilePath "C:\Program Files\nodejs\npx.cmd" -ArgumentList '--yes','electron','C:\Users\rkdtk\downcat' -WindowStyle Minimized
Start-Sleep 6
"ping:"; (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:47653/ping).Content
"no-token(→403 기대):"; try { Invoke-WebRequest -UseBasicParsing -Method Post http://127.0.0.1:47653/add -Body '{"url":"https://ex.com/a.zip"}' } catch { $_.Exception.Response.StatusCode.value__ }
"with-token(→200 기대):"; (Invoke-WebRequest -UseBasicParsing -Method Post http://127.0.0.1:47653/add -Headers @{'X-Downcat-Token'=$tok} -Body '{"url":"https://ex.com/a.zip"}').StatusCode
```
Expected: ping이 `{"ok":true,"app":"downcat"}`; 토큰 없음 → `403`; 토큰 있음 → `200`. (앱 창은 수동으로 닫거나 다음 태스크에서 확인.)

> ⚠️ config.json은 gitignore됨 — 토큰이 git에 안 올라가는지 `git status`로 확인.

- [ ] **Step 6: 커밋** (main.js만)

```bash
git add main.js
git -c user.name=rkdtk -c user.email=rkdtkdwhd@gmail.com commit -m "feat(main): 브리지 서버 기동 + bridge-job 전달 + download referer 통과"
```

---

### Task 4: `preload.js` + `renderer.js` 배선 (카드 뜨고 다운로드) — 종단 검증

**Files:**
- Modify: `preload.js`
- Modify: `renderer.js`

**Interfaces:**
- Consumes: `bridge-job` IPC 이벤트(Task 3), `download`가 `extra` 인자를 받음.
- Produces: 브리지 job이 오면 카드가 뜨고 큐를 타 다운로드된다(referer 포함).

- [ ] **Step 1: preload 확장** — `preload.js` 수정

`download`에 `extra` 인자 추가, `onBridgeJob` 추가:
```js
  download: (jobId, url, mode, useCookie, thumbnail, extra) => ipcRenderer.invoke('download', { jobId, url, mode, useCookie, thumbnail, extra }),
```
그리고 `onClipboardUrl` 줄 **다음에** 추가:
```js
  onBridgeJob: (cb) => ipcRenderer.on('bridge-job', (_e, job) => cb(job)),
```

- [ ] **Step 2: renderer — 브리지 job 처리** — `renderer.js`의 `window.api.onClipboardUrl(...)` 블록(대략 279–282행) **다음에** 추가

```js
// 브리지(브라우저 확장)에서 온 작업: URL을 큐에 넣고 referer를 함께 실어 보낸다.
window.api.onBridgeJob((job) => {
  if (!job || !job.url) return;
  if (taskList.some(t => t.url === job.url && (t.status === 'downloading' || t.status === 'queued'))) return; // 중복 방지
  const t = { id: crypto.randomUUID(), url: job.url, mode: job.mode || 'auto',
    status: 'queued', count: 0, bytes: 0, thumb: null, _pct: 0, _seq: seq++,
    extra: job.referer ? { referer: job.referer } : null };
  taskList.unshift(t); queue.push(t); render(); pump();
});
```

- [ ] **Step 3: renderer — runOne이 extra 전달** — `runOne`(대략 203행)의 download 호출 수정

```js
  const r = await window.api.download(t.id, t.url, t.mode, useCookie, thumbnail, t.extra)
    .catch(() => ({ ok: false, count: 0, bytes: 0 }));
```
(일반 작업은 `t.extra`가 `undefined`라 기존과 동일하게 동작.)

📌 이 코드가 하는 일: 확장이 보낸 주문이 오면, 손으로 붙여넣은 것과 똑같이 카드가 생기고 순서대로 다운로드된다. 확장이 준 referer는 그 작업에만 붙여 보낸다.

- [ ] **Step 4: 문법 확인**

Run: `node --check preload.js && node --check renderer.js`
Expected: 출력 없음.

- [ ] **Step 5: 종단 GUI 스모크** — 앱 띄우고 curl로 실제 파일 받기

Run (PowerShell):
```powershell
$tok = (Get-Content C:\Users\rkdtk\downcat\config.json -Raw | ConvertFrom-Json).bridgeToken
Start-Process -FilePath "C:\Program Files\nodejs\npx.cmd" -ArgumentList '--yes','electron','C:\Users\rkdtk\downcat'
Start-Sleep 6
$body = '{"url":"https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-32bit-build1.zip","mode":"auto"}'
(Invoke-WebRequest -UseBasicParsing -Method Post http://127.0.0.1:47653/add -Headers @{'X-Downcat-Token'=$tok} -Body $body).StatusCode
Start-Sleep 12
"받은 파일:"; Get-ChildItem C:\Users\rkdtk\downcat\downloads\*.zip | Select-Object Name,Length
```
Expected: `/add` → `200`; 받냥이 창에 카드가 뜨고 aria2로 받아 몇 초 뒤 `downloads\aria2-...win-32bit...zip`(약 2.4MB)이 생김. (창에서 카드가 보이는지 눈으로도 확인 — 스크린샷 원하면 `clip.ps1`.)

- [ ] **Step 6: 기존 회귀 확인**

Run: `node test_aria2.js && node test_engine.js && node test_bridge.js`
Expected: 셋 다 PASS.

- [ ] **Step 7: 커밋**

```bash
git add preload.js renderer.js
git -c user.name=rkdtk -c user.email=rkdtkdwhd@gmail.com commit -m "feat(renderer): 브리지 job을 카드로 큐잉 + referer 전달(종단 연결)"
```

---

## 자기 점검 (Self-Review)

**Spec 커버리지 (M2 범위):**
- ✅ 127.0.0.1:47653 루프백 HTTP 서버 — Task 2.
- ✅ 토큰 인증(403) + 본문 상한 + 라우트 허용목록 — Task 2.
- ✅ CORS: 확장 origin만, PNA 프리플라이트 — Task 2.
- ✅ `/ping`으로 앱 생존 감지 — Task 2.
- ✅ job을 clipboard-url과 같은 흐름으로 렌더러에 — Task 3/4.
- ✅ 창 없으면 503 — Task 3.
- ✅ 토큰 config.json 저장(gitignore) — Task 3.
- ✅ referer 전달(engine 재사용) — Task 3/4.
- ✅ 카드 UI 재사용, 새 다운로드 경로 안 만듦 — Task 4.
- 범위 밖(M3): 쿠키·User-Agent 전달, 확장 자체, 리소스 수집기. 이 계획에 없음(맞음).

**Placeholder 스캔:** 모든 스텝에 실제 코드/명령/기대출력. TBD 없음.

**타입 일관성:** `parseAddBody` 반환 `{job}|{error}` — Task 2 서버가 `parsed.error`/`parsed.job` 사용, 일치. `createBridgeServer({token,onJob})` — Task 3이 동일 시그니처로 호출, onJob이 boolean 반환, 일치. `bridge-job` 이벤트 job 형태 `{url,mode,referer?}` — Task 4 renderer가 `job.url/job.mode/job.referer` 사용, 일치. `download(...,extra)` — preload·renderer·main IPC 셋 다 `extra` 마지막 인자로 일치.

**보안 점검(줄이지 않은 것):** 루프백 바인딩(외부 차단), 토큰 필수, Origin 확장 한정, 본문 64KB 상한, 메서드/경로 허용목록, 토큰 git 유출 없음(config.json ignore). 토큰은 crypto.randomBytes(24)=192비트.

**미리 확인할 위험:**
- 포트 47653 점유 시: 서버 error 로그만, 앱은 계속. 확장은 연결 실패로 감지(M3에서 안내).
- aria2 릴리스 URL(1.37.0) 죽으면 Task 4 스모크 URL을 최신으로 교체.
