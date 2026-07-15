# M1 — aria2 가속 다운로드 엔진 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **코드 착수 전 반드시 `andrej-karpathy-skills:karpathy-guidelines` 스킬 호출** (CLAUDE.md 규칙).

**Goal:** 받냥이에 일반 파일 URL을 aria2c로 다중 연결(16) 가속 다운로드하는 엔진 경로를 추가한다. 확장 없이도 받냥이 창에 직링을 붙여넣으면 빠르게 받힌다.

**Architecture:** 새 `aria2.js`가 `bin/aria2c.exe`를 `spawn`해 진행률을 기존 `onEvent` 계약으로 흘린다. `engine.js`의 `pickTool()`이 직접 파일 링크를 `aria2`로 라우팅하고, `download()`는 aria2 경로를 `aria2.js`에 위임한 뒤 **기존 `scanNew`/`extractThumb`를 재사용**해 결과(개수·용량·썸네일)를 집계한다. 새 npm 의존 없음.

**Tech Stack:** Node(Electron) child_process.spawn, aria2c.exe, 순수함수 유닛테스트(node assert).

## Global Constraints

- 새 npm 의존성 추가 금지. Node 내장 모듈만.
- aria2 동시 연결 기본값 **16** (사용자 승인, IDM 32는 차단 위험).
- `onEvent({type, ...})` 계약 준수 — 기존 타입: `start`{tool,url}, `progress`{percent,speed,eta} 또는 {files}, `log`{line,isErr}, `error`{line}, `done`{...result}.
- `download()` 반환 형태 유지: `{ok, tool, code, canceled, count, bytes, thumb, file, error}` (main.js가 이 필드로 기록·알림 생성).
- 취소는 `opts.signal`(AbortController). aria2는 `--continue`로 다음에 이어받음.
- 쿠키/referer/UA는 `opts.cookieFile`/`opts.referer`/`opts.userAgent`로 받아 그대로 aria2에 전달(있을 때만). 확장(M3)이 나중에 채움.
- 커밋 작성자: `git -c user.name=rkdtk -c user.email=rkdtkdwhd@gmail.com commit`. 커밋 후 `git push origin master`.
- 의도적 단순화엔 `ponytail:` 주석. 코드 설명은 초등5학년도 알게 쉬운 한국어 주석.

---

### Task 1: `aria2.js` 순수 함수 (인자 빌더 + 진행률 파서)

**Files:**
- Create: `aria2.js`
- Test: `test_aria2.js`

**Interfaces:**
- Produces:
  - `aria2Args(url: string, outDir: string, opts: {connections?, referer?, userAgent?, cookieFile?, rateLimit?}) -> string[]`
  - `parseAria2Progress(line: string) -> {percent: number, speed: string|null, eta: string|null} | null`

- [ ] **Step 1: 실패하는 테스트 작성** — `test_aria2.js` 생성

```js
'use strict';
const assert = require('assert');
const { aria2Args, parseAria2Progress } = require('./aria2');

// 1) 인자 빌더: 연결수·referer·쿠키·속도제한·UA가 붙고 URL은 맨 끝
const a = aria2Args('https://ex.com/big.zip', 'out', {
  connections: 16, referer: 'https://ex.com/', cookieFile: 'c.txt', rateLimit: '5M', userAgent: 'UA',
});
assert(a.includes('--max-connection-per-server=16'));
assert(a.includes('--split=16'));
assert(a.includes('--continue=true'));
assert(a.includes('--referer=https://ex.com/'));
assert(a.includes('--load-cookies=c.txt'));
assert(a.includes('--max-download-limit=5M'));
assert(a.includes('--user-agent=UA'));
assert.strictEqual(a[a.length - 1], 'https://ex.com/big.zip');
// 기본 연결수 16 (opts 비어도)
assert(aria2Args('https://ex.com/x.zip', 'out', {}).includes('--split=16'));
// 선택 인자는 없으면 안 붙는다
assert(!aria2Args('https://ex.com/x.zip', 'out', {}).some(x => x.startsWith('--referer')));

// 2) 진행률 파서
const p = parseAria2Progress('[#2089b4 400MiB/1.2GiB(33%) CN:16 DL:5.2MiB ETA:2m34s]');
assert.strictEqual(p.percent, 33);
assert.strictEqual(p.speed, '5.2MiB/s');
assert.strictEqual(p.eta, '2m34s');
assert.strictEqual(parseAria2Progress('some log line'), null);
assert.strictEqual(parseAria2Progress(''), null);

console.log('ok - aria2Args, parseAria2Progress');
```

- [ ] **Step 2: 실패 확인**

Run: `node test_aria2.js`
Expected: FAIL — `Cannot find module './aria2'`

- [ ] **Step 3: 최소 구현** — `aria2.js` 생성 (순수 함수만, 이번 단계엔 `runAria2` 없음)

```js
'use strict';
// 받냥이 가속 엔진: 일반 파일 URL을 aria2c로 다중 연결 다운로드한다.
// engine.js가 tool==='aria2'일 때 이 모듈에 위임한다. yt-dlp 경로와 같은 onEvent 계약을 지킨다.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN_DIR = path.join(__dirname, 'bin');
const ARIA2 = fs.existsSync(path.join(BIN_DIR, 'aria2c.exe'))
  ? path.join(BIN_DIR, 'aria2c.exe')
  : 'aria2c';

// aria2c 실행 인자. 순수 함수 — 테스트로 검증한다.
// opts: connections(기본16), referer, userAgent, cookieFile, rateLimit
function aria2Args(url, outDir, opts) {
  opts = opts || {};
  const conn = opts.connections || 16;
  const args = [
    '--dir=' + outDir,
    '--continue=true',                        // 재개: 이어받기
    '--max-connection-per-server=' + conn,    // 한 서버에 최대 연결 수
    '--split=' + conn,                        // 파일을 몇 조각으로 나눠 받을지
    '--min-split-size=1M',
    '--content-disposition=true',             // 서버가 준 진짜 파일명 사용
    '--auto-file-renaming=false',
    '--allow-overwrite=false',
    '--summary-interval=1',                   // 1초마다 진행 요약 출력 → 진행률 파싱용
    '--console-log-level=warn',
    '--show-console-readout=true',
  ];
  if (opts.referer) args.push('--referer=' + opts.referer);
  if (opts.userAgent) args.push('--user-agent=' + opts.userAgent);
  if (opts.cookieFile) args.push('--load-cookies=' + opts.cookieFile);
  if (opts.rateLimit) args.push('--max-download-limit=' + opts.rateLimit);
  args.push(url);   // URL은 항상 맨 끝
  return args;
}

// aria2 요약 줄에서 진행률·속도·남은시간을 뽑는다. 없으면 null.
// 예: [#2089b4 400MiB/1.2GiB(33%) CN:16 DL:5.2MiB ETA:2m34s]
function parseAria2Progress(line) {
  const pct = line.match(/\((\d+)%\)/);
  if (!pct) return null;
  const dl = line.match(/DL:\s*([0-9.]+\s*[KMGT]?i?B)/i);
  const eta = line.match(/ETA:\s*([^\s\]]+)/i);
  return {
    percent: parseInt(pct[1], 10),
    speed: dl ? dl[1].replace(/\s+/g, '') + '/s' : null,
    eta: eta ? eta[1] : null,
  };
}

module.exports = { aria2Args, parseAria2Progress };
```

📌 이 코드가 하는 일: `aria2Args`는 "aria2한테 넘길 명령 조각들"을 배열로 만든다(16조각으로 나눠 이어받기 하며 받아라). `parseAria2Progress`는 aria2가 찍는 한 줄에서 "몇 %·속도·남은시간"만 콕 뽑는다.

- [ ] **Step 4: 통과 확인**

Run: `node test_aria2.js`
Expected: PASS — `ok - aria2Args, parseAria2Progress`

- [ ] **Step 5: 커밋**

```bash
git add aria2.js test_aria2.js
git -c user.name=rkdtk -c user.email=rkdtkdwhd@gmail.com commit -m "feat(aria2): 인자 빌더+진행률 파서 순수함수와 유닛테스트"
```

---

### Task 2: `engine.js` 라우팅 — 직링 파일을 aria2로

**Files:**
- Modify: `engine.js` (IMAGE_HOSTS/pickTool 근처, 대략 37–43행 + module.exports)
- Test: `test_aria2.js` (라우팅 테스트 추가)

**Interfaces:**
- Consumes: `aria2Args`/`parseAria2Progress` 없음(라우팅은 독립).
- Produces:
  - `isDirectFileUrl(url: string) -> boolean`
  - `pickTool(url, mode)` — `mode==='file'`이거나 직링 파일이면 `'aria2'` 반환.

- [ ] **Step 1: 실패하는 테스트 추가** — `test_aria2.js` 끝의 `console.log(...)` 줄 **앞에** 삽입

```js
// 3) 라우팅: 직링 파일 → aria2, 미디어 페이지 → ytdlp, 이미지 사이트 → gallerydl
const { pickTool, isDirectFileUrl } = require('./engine');
assert.strictEqual(pickTool('https://cdn.com/setup.exe', 'auto'), 'aria2');
assert.strictEqual(pickTool('https://cdn.com/movie.mp4', 'auto'), 'aria2');
assert.strictEqual(pickTool('https://www.youtube.com/watch?v=abc', 'auto'), 'ytdlp');
assert.strictEqual(pickTool('https://instagram.com/p/abc', 'auto'), 'gallerydl');
assert.strictEqual(pickTool('https://cdn.com/stream.m3u8', 'auto'), 'ytdlp'); // m3u8은 yt-dlp가 조립
assert.strictEqual(pickTool('https://cdn.com/x.zip', 'video'), 'ytdlp');      // 강제 모드가 우선
assert.strictEqual(pickTool('https://any.com/thing', 'file'), 'aria2');       // 강제 file
assert(isDirectFileUrl('https://cdn.com/a/b/file.pdf'));
assert(!isDirectFileUrl('https://cdn.com/page'));
assert(!isDirectFileUrl('not a url'));
```

이어서 마지막 `console.log` 줄을 아래로 교체:

```js
console.log('ok - aria2Args, parseAria2Progress, routing');
```

- [ ] **Step 2: 실패 확인**

Run: `node test_aria2.js`
Expected: FAIL — `pickTool('https://cdn.com/setup.exe','auto')`가 `'ytdlp'`라 `aria2` 아님 (또는 `isDirectFileUrl` undefined).

- [ ] **Step 3: 최소 구현** — `engine.js` 수정

(a) `IMAGE_HOSTS` 상수(대략 37행) **바로 아래**에 추가:

```js
// 직접 다운로드 링크(압축·설치·문서·미디어 직링)인지. 이런 건 aria2로 가속 다운로드한다.
// m3u8/mpd는 일부러 뺐다 — 조각 스트림이라 yt-dlp가 조립해야 한다.
const DIRECT_FILE_RE = /\.(zip|7z|rar|tar|gz|tgz|bz2|xz|exe|msi|dmg|pkg|apk|iso|img|bin|pdf|epub|mobi|mp3|flac|wav|mp4|mkv|webm|mov|m4v|avi|docx?|xlsx?|pptx?)$/i;
function isDirectFileUrl(url) {
  try { return DIRECT_FILE_RE.test(new URL(url).pathname); }
  catch { return false; }
}
```

(b) `pickTool`을 아래로 교체(대략 39–43행):

```js
function pickTool(url, mode) {
  if (mode === 'video') return 'ytdlp';
  if (mode === 'image') return 'gallerydl';
  if (mode === 'file') return 'aria2';                 // 확장/사용자가 파일로 지정
  return IMAGE_HOSTS.test(url) ? 'gallerydl'
    : isDirectFileUrl(url) ? 'aria2'                   // 직링 파일은 가속
    : 'ytdlp';                                         // 나머지(영상 페이지·모르는 곳)
}
```

(c) `module.exports`(대략 304행)에 `isDirectFileUrl` 추가:

```js
module.exports = { download, pickTool, isDirectFileUrl, expandListing, extractItemLinks, resolveEmbeddedSource, ytdlpArgs };
```

📌 이 코드가 하는 일: URL 끝이 `.zip`·`.exe`·`.mp4` 같은 "진짜 파일"이면 aria2로 빠르게, 유튜브처럼 페이지 주소면 yt-dlp로, 인스타 같은 이미지 사이트면 gallery-dl로 나눠 보낸다.

- [ ] **Step 4: 통과 확인**

Run: `node test_aria2.js`
Expected: PASS — `ok - aria2Args, parseAria2Progress, routing`

- [ ] **Step 5: 기존 테스트 회귀 확인**

Run: `node test_engine.js`
Expected: PASS — `ok - embedded videos get distinct output paths` (pickTool 시그니처 그대로라 안 깨져야 함)

- [ ] **Step 6: 커밋**

```bash
git add engine.js test_aria2.js
git -c user.name=rkdtk -c user.email=rkdtkdwhd@gmail.com commit -m "feat(engine): 직링 파일을 aria2로 라우팅"
```

---

### Task 3: `aria2.js` 실행부(`runAria2`) + `engine.js` download() 위임 + 실제 스모크

**Files:**
- Modify: `aria2.js` (`runAria2` 추가 + export)
- Modify: `engine.js` (`download()` 안에 aria2 분기)
- Binary: `bin/aria2c.exe` 내려받기

**Interfaces:**
- Consumes: `aria2Args`, `parseAria2Progress` (Task 1).
- Produces: `runAria2(url, outDir, opts, onEvent) -> Promise<{ok, code, canceled, error?}>`. opts는 `{connections, referer, userAgent, cookieFile, rateLimit, signal}`.

- [ ] **Step 1: aria2c.exe 확보** (스모크에 필요)

Run (PowerShell):
```powershell
$u='https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip'
$z="$env:TEMP\aria2.zip"; $d="$env:TEMP\aria2x"
Invoke-WebRequest -Uri $u -OutFile $z; Expand-Archive $z $d -Force
Copy-Item (Get-ChildItem $d -Recurse -Filter aria2c.exe).FullName "C:\Users\rkdtk\downcat\bin\aria2c.exe" -Force
& "C:\Users\rkdtk\downcat\bin\aria2c.exe" --version | Select-Object -First 1
```
Expected: `aria2 version 1.37.0` 비슷한 줄. (URL이 404면 https://github.com/aria2/aria2/releases 에서 최신 win-64bit zip 파일명으로 교체.)

> ⚠️ `bin/aria2c.exe`는 용량 커서 커밋 안 함 — `.gitignore` 확인. `bin/*.exe`가 무시 목록에 없으면 추가(기존 yt-dlp.exe/ffmpeg.exe도 커밋 안 되어 있음).

- [ ] **Step 2: `runAria2` 구현** — `aria2.js`의 `module.exports` **앞에** 추가

```js
// aria2c가 PATH에도 없고 bin에도 없을 때 확인용
function commandExists() {
  try { execFileSync('aria2c', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// 실제 실행. resolve -> {ok, code, canceled}. 파일 집계는 engine이 scanNew로 한다.
function runAria2(url, outDir, opts, onEvent) {
  opts = opts || {};
  onEvent = onEvent || (() => {});
  if (ARIA2 === 'aria2c' && !commandExists()) {
    const msg = 'aria2c가 없어요 — 설정에서 자동 설치하거나 bin 폴더에 aria2c.exe를 넣어주세요';
    onEvent({ type: 'error', line: msg });
    return Promise.resolve({ ok: false, code: -1, error: msg });
  }
  const args = aria2Args(url, outDir, opts);
  onEvent({ type: 'start', tool: 'aria2', url });
  return new Promise((resolve) => {
    const child = spawn(ARIA2, args, { windowsHide: true, signal: opts.signal });
    const handle = (buf, isErr) => {
      // aria2 진행 표시는 \r로 갱신되니 \r·\n 둘 다로 쪼갠다
      for (const line of buf.toString().split(/[\r\n]+/)) {
        if (!line.trim()) continue;
        const p = parseAria2Progress(line);
        if (p) { onEvent({ type: 'progress', ...p }); continue; }
        onEvent({ type: 'log', line, isErr });
      }
    };
    child.stdout.on('data', b => handle(b, false));
    child.stderr.on('data', b => handle(b, true));
    child.on('error', (e) => {
      if (opts.signal && opts.signal.aborted) { resolve({ ok: false, canceled: true }); return; }
      onEvent({ type: 'error', line: String(e) });
      resolve({ ok: false, code: -1, error: String(e) });
    });
    child.on('close', (code) => {
      const canceled = !!(opts.signal && opts.signal.aborted);
      resolve({ ok: code === 0 && !canceled, code, canceled });
    });
  });
}
```

그리고 export 교체:
```js
module.exports = { aria2Args, parseAria2Progress, runAria2 };
```

- [ ] **Step 3: `engine.js` download()에 aria2 분기** — `const tool = pickTool(url, opts.mode || 'auto');` **바로 다음**, `let cmd, args;` **앞에** 삽입

```js
  // aria2 경로: aria2.js에 위임하고, 파일 집계는 아래 yt-dlp 폴백과 같은 scanNew를 재사용한다(DRY).
  if (tool === 'aria2') {
    const startTime = Date.now();
    const r = await require('./aria2').runAria2(url, outDir, {
      connections: opts.connections, referer: opts.referer, userAgent: opts.userAgent,
      cookieFile: opts.cookieFile, rateLimit: opts.rateLimit, signal: opts.signal,
    }, onEvent);
    const canceled = !!(opts.signal && opts.signal.aborted) || !!r.canceled;
    const acc = { count: 0, bytes: 0, thumb: null, any: null, video: null };
    // ponytail: 이어받기(--continue)로 새 파일이 안 생기면 count 0일 수 있음. 새 다운로드는 정상 집계.
    if (r.ok) scanNew(outDir, startTime - 2000, acc);
    if (!acc.thumb && acc.video) acc.thumb = await extractThumb(acc.video);
    const result = { ok: r.ok, tool: 'aria2', code: r.code, canceled,
      count: acc.count, bytes: acc.bytes, thumb: acc.thumb, file: acc.any, error: r.error };
    onEvent({ type: 'done', ...result });
    return result;
  }
```

> 참고: `scanNew`·`extractThumb`·`IMG_RE`·`VID_RE`는 `engine.js`에 이미 정의돼 있어 그대로 쓴다. `require('./aria2')`는 순환참조 피하려 함수 안에서 지연 로드.

- [ ] **Step 4: 스모크 — 실제 파일 다운로드**

Run:
```bash
cd /c/Users/rkdtk/downcat && node engine.js "https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-32bit-build1.zip" auto
```
Expected: `[aria2] 시작: ...` 출력 후 `진행률: NN% ...`가 올라가다 `끝 (code=0)`. `downloads/` 폴더에 `.zip`이 실제로 생기고 용량 > 0.

검증:
```bash
ls -la /c/Users/rkdtk/downcat/downloads/*.zip
```
Expected: zip 파일 존재, 크기 수 MB.

- [ ] **Step 5: 취소 스모크** (선택, 큰 파일로 Ctrl+C 시 `.aria2` 이어받기 파일 남는지) — 생략 가능.

- [ ] **Step 6: 커밋**

```bash
git add aria2.js engine.js
git -c user.name=rkdtk -c user.email=rkdtkdwhd@gmail.com commit -m "feat(engine): aria2 실행부와 download 위임 + 스모크 통과"
```

---

### Task 4: `main.js` aria2 자동 설치/상태 IPC (ffmpeg 패턴 복제)

**Files:**
- Modify: `main.js` (FFMPEG 상수/핸들러 근처, 대략 137–164행 뒤)

**Interfaces:**
- Consumes: 없음(Electron IPC).
- Produces: IPC `aria2-status` -> `boolean`, `install-aria2` -> `{ok, error?}`. 렌더러가 나중에 버튼으로 연결(M3/설정). M1은 배관까지.

- [ ] **Step 1: 구현** — `main.js`의 `install-ffmpeg` 핸들러 블록(대략 164행 `});`) **바로 뒤**에 추가

```js
// aria2c (일반 파일 가속 다운로드용) 상태 확인 / 자동 설치 — ffmpeg 패턴과 동일
const ARIA2C = path.join(__dirname, 'bin', 'aria2c.exe');
ipcMain.handle('aria2-status', () => fs.existsSync(ARIA2C));
ipcMain.handle('install-aria2', async () => {
  const { execFile } = require('child_process');
  const url = 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip';
  const tmpDir = path.join(app.getPath('temp'), 'downcat-aria2');
  const zip = tmpDir + '.zip';
  try {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    const ps = `$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '${url}' -OutFile '${zip}'; Expand-Archive -Path '${zip}' -DestinationPath '${tmpDir}' -Force`;
    await new Promise((res, rej) => execFile('powershell', ['-NoProfile', '-Command', ps], { maxBuffer: 1 << 28 }, (e) => e ? rej(e) : res()));
    let found = null;
    (function walkFor(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walkFor(f);
        else if (!found && e.name.toLowerCase() === 'aria2c.exe') found = f;
      }
    })(tmpDir);
    if (!found) throw new Error('압축 안에서 aria2c.exe를 못 찾음');
    fs.mkdirSync(path.dirname(ARIA2C), { recursive: true });
    fs.copyFileSync(found, ARIA2C);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); fs.rmSync(zip, { force: true }); } catch {}
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
```

📌 이 코드가 하는 일: 받냥이 안에서 aria2c.exe가 있는지 확인하고, 없으면 인터넷에서 공식 zip을 받아 풀어 `bin`에 aria2c.exe만 복사한다. ffmpeg 자동설치와 똑같은 방식.

- [ ] **Step 2: 문법 확인** (검증 사다리 ①)

Run: `node --check main.js`
Expected: 출력 없음(문법 OK).

- [ ] **Step 3: GUI 스모크** — 앱이 뜨고 IPC가 등록되는지

Run (PowerShell):
```powershell
$env:DOWNCAT_SMOKE='__settings__'; & "C:\Program Files\nodejs\npx.cmd" --yes electron "C:\Users\rkdtk\downcat" 2>&1 | Select-String -Pattern 'error|throw' | Select-Object -First 5
```
Expected: 에러 줄 없음(창이 뜨고 30초 뒤 자동 종료). aria2-status 핸들러 등록 실패 시 여기서 예외가 보임.

- [ ] **Step 4: 커밋**

```bash
git add main.js
git -c user.name=rkdtk -c user.email=rkdtkdwhd@gmail.com commit -m "feat(main): aria2c 자동설치/상태 IPC (ffmpeg 패턴)"
git push origin master
```

---

## 자기 점검 (Self-Review)

**Spec 커버리지 (M1 범위):**
- ✅ aria2 다중연결 가속 다운로드(16) — Task 1(인자)+Task 3(실행).
- ✅ 직링 파일 라우팅 — Task 2.
- ✅ 재개(`--continue`) — Task 1 인자.
- ✅ 쿠키·referer·UA·속도제한 전달 — Task 1 인자(있을 때만), 확장이 M3에서 채움.
- ✅ 진행률 UI 연동 — 기존 `onEvent` 계약 재사용, Task 3.
- ✅ aria2c 없음 에러/자동설치 — Task 3 에러 메시지 + Task 4 IPC.
- ✅ 취소 — `opts.signal`, Task 3.
- ✅ 유닛+스모크 검증 — Task 1/2 유닛, Task 3/4 스모크.
- 범위 밖(M2~): 로컬 브리지, 확장, magnet/체크섬 — 이 계획에 없음(맞음).

**Placeholder 스캔:** 모든 스텝에 실제 코드/명령/기대출력 있음. TBD 없음.

**타입 일관성:** `runAria2` 반환 `{ok,code,canceled,error?}` — Task 3 download 분기가 `r.ok/r.code/r.canceled/r.error` 사용, 일치. `pickTool`은 문자열 `'aria2'` 반환 — download 분기 `tool==='aria2'`와 일치. `aria2Args`/`parseAria2Progress` 시그니처 Task 1 정의 = Task 3 사용 일치.

**미리 확인할 위험:**
- aria2 릴리스 URL 버전(1.37.0)이 죽으면 Task 3 Step1·Task 4에서 최신 파일명으로 교체.
- `.gitignore`에 `bin/*.exe` 없으면 Task 3에서 추가(큰 바이너리 커밋 방지).
