'use strict';
// 받냥이 다운로드 엔진: URL을 보고 yt-dlp(영상) 또는 gallery-dl(이미지)로 넘겨 받는다.
// GUI(main.js)에서 require 해서 쓰고, 터미널에서 `node engine.js <URL>`로도 쓴다.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 도구 폴더. 도구 관리자(tools.js)가 실행 중에 새로 깔 수 있으니 경로는 "쓸 때마다" 찾는다.
let BIN_DIR = path.join(__dirname, 'bin');
function setBinDir(dir) { BIN_DIR = dir; }

// bin 안의 실행파일 찾기: Windows는 name.exe, 그 밖(테스트용 리눅스 등)은 확장자 없는 name도 본다.
function binFile(name) {
  for (const f of [name + '.exe', name]) {
    const p = path.join(BIN_DIR, f);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

// 테스트용: 도구 실행을 가짜 프로그램으로 바꿔 끼운다. { ytdlp: {cmd, pre:[...]}, gallerydl: {...} }
let toolOverrides = {};
function _setToolOverrides(map) { toolOverrides = map || {}; }

// yt-dlp 실행 방법 {cmd, pre}. bin → PATH 순.
function resolveYtdlp() {
  if (toolOverrides.ytdlp) return toolOverrides.ytdlp;
  return { cmd: binFile('yt-dlp') || 'yt-dlp', pre: [] };
}

// ffmpeg가 있으면 화질 좋은 영상+소리 합치기, 없으면 단일 파일(best)로 안전하게.
// 반환: bin 폴더 경로(bin에 있음) / ''(PATH에 있음) / null(없음)
function findFfmpeg() {
  if (binFile('ffmpeg')) return BIN_DIR;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return ''; } // PATH에 있음
  catch { return null; } // 없음
}

// ── 도구 출력 읽기 (한글 경로 버그 수정의 핵심) ──
// 1) 도구에게 UTF-8로 출력하라고 시킨다(아래 TOOL_ENV + 각 도구 옵션).
// 2) 그래도 cp949(한국어 Windows 기본)로 나오면 그 줄만 cp949로 다시 읽는다.
// 3) 출력이 한 줄 중간에서 끊겨 들어와도, 줄바꿈이 올 때까지 바이트로 모았다가 한 번에 읽는다.
const TOOL_ENV = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }; // yt-dlp·gallery-dl 둘 다 파이썬 프로그램
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
let CP949 = null;
try { CP949 = new TextDecoder('euc-kr'); } catch {} // WHATWG 'euc-kr' = 윈도우 cp949. Electron 32에서 동작 확인
function decodeLine(buf) {
  try { return UTF8_STRICT.decode(buf); }
  catch { return CP949 ? CP949.decode(buf) : buf.toString('utf8'); }
}

// 바이트 조각을 받아 완성된 줄만 onLine(문자열)으로 넘긴다. \n, \r\n, \r 모두 줄 끝으로 본다.
function createLineReader(onLine) {
  let pending = null;
  const emit = (b) => { if (b.length) onLine(decodeLine(b)); };
  return {
    push(chunk) {
      let buf = pending ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (c === 0x0a || c === 0x0d) { emit(buf.subarray(start, i)); start = i + 1; }
      }
      pending = start < buf.length ? Buffer.from(buf.subarray(start)) : null;
    },
    end() { if (pending) { emit(pending); pending = null; } },
  };
}

// python 실제 exe 경로 찾기 (gallery-dl 실행용). shell 안 쓰려고 절대경로로.
// 진짜 python이 없으면 null (MS스토어 가짜 python.exe는 스토어만 열리므로 제외).
let _python;
function getPython() {
  if (_python !== undefined) return _python;
  try {
    const out = execFileSync('where', ['python'], { encoding: 'utf8' });
    const exe = out.split(/\r?\n/).map(l => l.trim())
      .find(l => l.toLowerCase().endsWith('.exe') && !/WindowsApps/i.test(l));
    _python = exe || null;
  } catch { _python = null; }
  return _python;
}

// gallery-dl 실행 방법 {cmd, pre} 또는 null(없음). bin → (Windows) python -m gallery_dl → (그 밖) PATH.
function resolveGallerydl() {
  if (toolOverrides.gallerydl) return toolOverrides.gallerydl;
  const exe = binFile('gallery-dl');
  if (exe) return { cmd: exe, pre: [] }; // 동봉/자동설치 실행파일 우선 — python 설치 불필요
  if (process.platform === 'win32') {
    const py = getPython();
    return py ? { cmd: py, pre: ['-m', 'gallery_dl'] } : null;
  }
  return { cmd: 'gallery-dl', pre: [] };
}

// 이미지 갤러리 사이트는 gallery-dl로. 나머지(영상 포함, 모르는 곳)는 yt-dlp로.
// 주소 전체가 아니라 "호스트 이름"만 본다 — 예전엔 ?ref=instagram.com 같은 꼬리말에도 걸렸다.
const IMAGE_DOMAINS = [
  'instagram.com', 'pixiv.net', 'hitomi.la', 'deviantart.com', 'tumblr.com', 'imgur.com',
  'flickr.com', 'artstation.com',
  'x.com', 'twitter.com', 'blog.naver.com', 'bsky.app', 'behance.net', // 새로 추가
];
const IMAGE_HOST_PREFIX = /(?:^|\.)(?:pinterest|nhentai|e-hentai|exhentai|danbooru|gelbooru|weibo)\./i; // pinterest.co.kr 등 나라별 주소
function isImageHost(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return IMAGE_DOMAINS.some(d => host === d || host.endsWith('.' + d)) || IMAGE_HOST_PREFIX.test(host);
}

// 직접 다운로드 링크(압축·설치·문서·미디어 직링)인지. 이런 건 aria2로 가속 다운로드한다.
// m3u8/mpd는 일부러 뺐다 — 조각 스트림이라 yt-dlp가 조립해야 한다.
const DIRECT_FILE_RE = /\.(zip|7z|rar|tar|gz|tgz|bz2|xz|exe|msi|dmg|pkg|apk|iso|img|bin|pdf|epub|mobi|mp3|flac|wav|mp4|mkv|webm|mov|m4v|avi|docx?|xlsx?|pptx?)$/i;
function isDirectFileUrl(url) {
  try { return DIRECT_FILE_RE.test(new URL(url).pathname); }
  catch { return false; }
}

function pickTool(url, mode) {
  if (mode === 'video') return 'ytdlp';
  if (mode === 'image') return 'gallerydl';
  if (mode === 'file') return 'aria2';                 // 확장/사용자가 파일로 지정
  return isImageHost(url) ? 'gallerydl'
    : isDirectFileUrl(url) ? 'aria2'                   // 직링 파일은 가속
    : 'ytdlp';                                         // 나머지(영상 페이지·모르는 곳)
}

// 로그인 쿠키 인자: 파일(cookies.txt)이 있으면 그걸 우선, 없으면 브라우저 자동.
// 크롬은 앱 바운드 암호화 때문에 브라우저 자동이 안 되니 보통 파일을 쓴다.
function cookieArgs(cookies, cookieFile) {
  if (cookieFile) return ['--cookies', cookieFile];
  if (cookies) return ['--cookies-from-browser', cookies];
  return [];
}

// yt-dlp 실행 인자 만들기. o.thumbnail=영상썸네일, o.ytHeight=최대 세로해상도(1080 등).
function ytdlpArgs(url, outDir, o) {
  const ff = findFfmpeg();
  const prefix = o.outputPrefix ? `${o.outputPrefix} ` : '';
  const args = [
    '--newline',
    '--encoding', 'utf-8', // 한국어 Windows에서 경로가 cp949로 찍히는 문제 방지
    '--progress-template', 'DLPCT:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    // 받은(또는 이미 있던) 파일의 최종 경로를 한 줄씩 찍게 한다 → 집계가 옆 작업과 안 섞임
    '--print', 'after_move:DCFILE:%(filepath)s', '--no-simulate',
    '-o', path.join(outDir, '%(extractor)s', '%(uploader)s', `${prefix}%(title)s [%(id)s].%(ext)s`),
  ];
  const h = o.ytHeight ? `[height<=${o.ytHeight}]` : '';
  if (o.format) args.push('-f', o.format);              // 확장에서 고른 특정 포맷(화질) 우선
  else if (ff !== null) args.push('-f', `bv*${h}+ba/b${h}/b`); else args.push('-f', `b${h}/b`);
  if (ff) args.push('--ffmpeg-location', ff);
  if (o.thumbnail) args.push('--write-thumbnail');
  if (o.polite) args.push(
    '-t', 'sleep',
    '--retries', '3', '--fragment-retries', '3',
    '--retry-sleep', 'http:exp=5:60', '--retry-sleep', 'fragment:exp=5:60',
  );
  if (o.rateLimit) args.push('--limit-rate', o.rateLimit);
  if (o.referer) args.push('--referer', o.referer); // 야스닷컴 계열: 이 헤더 없으면 서버가 막는다
  if (o.userAgent) args.push('--user-agent', o.userAgent); // 확장이 준 브라우저 UA(있을 때만)
  args.push(...cookieArgs(o.cookies, o.cookieFile));
  args.push(url);
  return args;
}

// gallery-dl 실행 인자 (bin/gallery-dl.exe 또는 python -m gallery_dl 공용)
function gallerydlArgs(url, outDir, o) {
  // 표준출력/오류를 UTF-8로 (한국어 Windows 기본값 cp949 → 한글 경로 깨짐 방지)
  const args = ['-o', 'output.stdout=utf-8', '-o', 'output.stderr=utf-8', '-d', outDir];
  if (/instagram\.com/i.test(url)) {
    // 파일명 보기 좋게: 계정_날짜_게시물코드_순번
    args.push('-f', '{username}_{post_date:%Y-%m-%d}_{post_shortcode}_{num:>02}.{extension}');
    if (o.stories) args.push('-o', 'include=posts,reels,stories,highlights'); // 스토리도 포함
    // 인스타는 요청이 너무 빠르면 봇으로 보고 잠깐 막는다(429). 요청 사이에 3~6초 쉬어 사람처럼,
    // 그래도 막히면(429) 60초 기다렸다 재시도 → "자꾸 막힘" 방지.
    args.push('--sleep-request', '3.0-6.0', '--sleep-429', '60');
  }
  if (o.rateLimit) args.push('--limit-rate', o.rateLimit);
  args.push(...cookieArgs(o.cookies, o.cookieFile));
  args.push(url);
  return args;
}

// 다운로드 후: outDir에서 이번에 새로 생긴 파일들을 세어 개수·용량·썸네일을 구한다.
// ponytail: outDir 전체 재귀스캔. 라이브러리가 수만 개면 하위폴더 한정으로 좁힐 것.
const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const VID_RE = /\.(mp4|webm|mkv|mov|avi|m4v)$/i;
function scanNew(dir, since, acc) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scanNew(full, since, acc);
    else {
      let st; try { st = fs.statSync(full); } catch { continue; }
      // birthtime(로컬 생성시각) 사용. mtime은 서버 원본 날짜라 못 씀.
      if (st.birthtimeMs >= since) {
        acc.count++; acc.bytes += st.size;
        if (!acc.any) acc.any = full;
        if (!acc.thumb && IMG_RE.test(e.name)) acc.thumb = full;
        if (!acc.video && VID_RE.test(e.name)) acc.video = full;
      }
    }
  }
}

// 영상만 받았으면(이미지 썸네일 없음) ffmpeg로 1초 지점 한 장면을 뽑아 카드 썸네일로 쓴다.
let THUMBS_DIR = path.join(__dirname, 'thumbs');
function setThumbsDir(dir) { THUMBS_DIR = dir; }
function extractThumb(video) {
  const ffDir = findFfmpeg();
  if (ffDir === null) return Promise.resolve(null); // ffmpeg 없으면 아이콘으로 표시
  const ffmpeg = ffDir ? path.join(ffDir, 'ffmpeg.exe') : 'ffmpeg';
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  // 전체 경로 해시를 붙여 다른 폴더의 같은 파일명끼리 안 겹치게
  const hash = require('crypto').createHash('md5').update(video).digest('hex').slice(0, 8);
  const out = path.join(THUMBS_DIR, path.basename(video).replace(/\.[^.]+$/, '') + '-' + hash + '.jpg');
  return new Promise((res) => {
    const { execFile } = require('child_process');
    execFile(ffmpeg, ['-y', '-ss', '1', '-i', video, '-frames:v', '1', '-vf', 'scale=128:-2', out],
      { windowsHide: true }, (err) => res(!err && fs.existsSync(out) ? out : null));
  });
}

// 야스닷컴 계열 CMS: 영상 진짜 주소를 페이지 JS `sourceUrl = "..."` 변수에 숨겨둔다.
// yt-dlp는 페이지만 봐선 못 찾으니, 페이지를 받아 그 주소를 뽑고 referer를 붙여 넘긴다.
// 대상 호스트의 _Action=items 페이지만 처리 — 유튜브·인스타 같은 일반 사이트는 안 걸린다.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
function isYasCmsUrl(url) {
  try { return /^yasyadong\d*\.tv$/i.test(new URL(url).hostname.replace(/^www\./, '')); }
  catch { return false; }
}

async function resolveEmbeddedSource(url, signal) {
  if (!isYasCmsUrl(url) || !/[?&]_Action=items(?:&|$)/i.test(url)) return null;
  let html;
  try {
    const timeout = AbortSignal.timeout(15000);
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) return { error: `페이지 연결 실패: HTTP ${res.status}` };
    html = await res.text();
  } catch (err) {
    const reason = (err.cause && err.cause.code) || err.code || err.message;
    return { error: `페이지 연결 실패: ${reason}` };
  }
  const m = html.match(/\bsourceUrl\s*=\s*"([^"]+)"/); // const sourceUrl = "https:\/\/..."
  if (!m) return null;
  const src = m[1].replace(/\\\//g, '/'); // \/ 이스케이프 풀기
  if (!/^https?:\/\//i.test(src)) return null;
  const page = new URL(url);
  const itemId = page.searchParams.get('items_id');
  const outputPrefix = /^\d+$/.test(itemId || '') ? `${page.hostname}-${itemId}` : '';
  return { url: src, referer: page.origin + '/', outputPrefix };
}

// 야스닷컴 계열 목록 페이지(대문·index·hot·best·검색 등)에서 영상 링크를 모두 뽑는다.
// 영상 링크 형식: ?_Action=items&items_id=<번호> (href에선 &가 &amp;로 나옴).
// items_id로 중복 제거해 절대 URL 배열로 돌려준다. 순수 함수라 저장된 HTML로 검증 가능.
function extractItemLinks(html, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const ids = new Set();
  const out = [];
  const re = /_Action=items&(?:amp;)?items_id=(\d+)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (ids.has(m[1])) continue;
    ids.add(m[1]);
    out.push(`${origin}/?_Action=items&items_id=${m[1]}`);
  }
  return out;
}

// 목록 페이지 URL 하나 → 그 안 영상 페이지 URL들. 목록이 아니면(또는 실패) 빈 배열.
async function expandListing(url) {
  if (!isYasCmsUrl(url)) return [];
  let html;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    html = await res.text();
  } catch { return []; }
  return extractItemLinks(html, url);
}

// 실패 원인 알아보기 (도구 출력 한 줄 기준)
const UNSUPPORTED_RE = /Unsupported URL/i; // yt-dlp: "ERROR: Unsupported URL: ...", gallery-dl: "Unsupported URL '...'"
// 로그인이 필요해 보이는 오류: 401·403, "Sign in"(유튜브 "Sign in to confirm…"), gallery-dl 인증 오류
const LOGIN_RE = /HTTP Error 40[13]\b|\b40[13][ :'"]+(?:Unauthorized|Forbidden|Client Error)|\bSign in\b|login required|log in to|requires? (?:authentication|login)|AuthRequired|AuthenticationError|AuthorizationError|redirect to login page|accounts\/login|login_required|rate-limit reached or login required/i;
const ERRORISH_RE = /\bERROR\b|\[error\]|Error:/i;
const LOGIN_HINT = '로그인이 필요해 보여요 — [🔑 로그인]을 눌러 보세요';

// 실패 결과에 사람이 읽을 이유를 붙인다(로그인 안내 > 마지막 오류 줄).
function explainFailure(result, info) {
  if (result.ok || result.canceled) return result;
  if (info.needsLogin) { result.needsLogin = true; result.error = LOGIN_HINT; }
  else if (!result.error && info.lastError) result.error = info.lastError.replace(/^ERROR:\s*/i, '').slice(0, 200);
  return result;
}

/**
 * URL 하나를 받는다.
 * onEvent({type, percent?, line?, code?}) 로 진행 상황을 알려준다. 'done'은 끝에 딱 한 번.
 * 반환: Promise -> {ok, tool, code, count, bytes, thumb, file, error?, needsLogin?, fallbackFrom?}
 */
async function download(url, opts, onEvent) {
  opts = opts || {};
  onEvent = onEvent || (() => {});
  const outDir = opts.outDir || path.join(__dirname, 'downloads');
  fs.mkdirSync(outDir, { recursive: true });
  if (isYasCmsUrl(url) && /[?&]_Action=items(?:&|$)/i.test(url)) opts = { ...opts, polite: true };
  // 야스닷컴 계열이면 페이지 속 진짜 주소로 바꾸고 referer를 켠다
  const resolved = await resolveEmbeddedSource(url, opts.signal);
  if (opts.signal && opts.signal.aborted) {
    return { ok: false, tool: 'ytdlp', canceled: true, code: null, count: 0, bytes: 0, thumb: null, file: null };
  }
  if (resolved && resolved.error) {
    onEvent({ type: 'error', line: resolved.error });
    return { ok: false, tool: 'ytdlp', code: -1, count: 0, bytes: 0, thumb: null, file: null, error: resolved.error };
  }
  if (resolved) { url = resolved.url; opts = { ...opts, referer: resolved.referer, outputPrefix: resolved.outputPrefix }; }
  const mode = opts.mode || 'auto';
  const tool = pickTool(url, mode);

  let result = await runTool(tool, url, outDir, opts, onEvent);
  // 자동 분배 보완: yt-dlp가 "지원하지 않는 주소"라고 하면 gallery-dl로 한 번 더 시도한다.
  if (tool === 'ytdlp' && mode === 'auto' && result.unsupported && !result.count && !result.canceled) {
    onEvent({ type: 'log', line: 'yt-dlp가 지원하지 않는 주소라 gallery-dl로 다시 시도해요', isErr: false });
    result = await runTool('gallerydl', url, outDir, opts, onEvent);
    result.fallbackFrom = 'ytdlp';
    if (result.unsupported && !result.ok && !result.needsLogin) result.error = '지원하지 않는 주소예요 (yt-dlp·gallery-dl 둘 다)';
  }
  delete result.unsupported;
  onEvent({ type: 'done', ...result });
  return result;
}

// 도구 하나를 실제로 돌린다. 'done' 이벤트는 안 보낸다(download가 마지막에 한 번 보냄).
async function runTool(tool, url, outDir, opts, onEvent) {
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
    return { ok: r.ok, tool: 'aria2', code: r.code, canceled,
      count: acc.count, bytes: acc.bytes, thumb: acc.thumb, file: acc.any, error: r.error };
  }

  let run, args;
  if (tool === 'ytdlp') { run = resolveYtdlp(); args = ytdlpArgs(url, outDir, opts); }
  else {
    run = resolveGallerydl();
    args = gallerydlArgs(url, outDir, opts);
    if (!run) { // 진짜 python 없음 → 스토어 창 대신 이유를 알려주고 바로 실패
      const msg = 'gallery-dl이 없어요 — ⚙ 설정의 [지금 모두 확인·업데이트]를 눌러 설치해 주세요';
      onEvent({ type: 'error', line: msg });
      return { ok: false, tool, code: -1, count: 0, bytes: 0, thumb: null, file: null, error: msg };
    }
  }

  onEvent({ type: 'start', tool, url });
  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = spawn(run.cmd, [...run.pre, ...args], {
      windowsHide: true, signal: opts.signal, env: { ...process.env, ...TOOL_ENV },
    });
    const jobFiles = []; let newCount = 0; // 이 작업의 출력에서 직접 모은 파일 목록
    const info = { noModule: false, unsupported: false, needsLogin: false, lastError: null };
    const handleLine = (line, isErr) => {
      if (!line.trim()) return;
      const m = line.match(/DLPCT:\s*([\d.]+)%\|([^|]*)\|(.*)/); // yt-dlp 진행률|속도|남은시간
      if (m) {
        const clean = (s) => { s = s.trim(); return s && !/unknown|^n\/?a$/i.test(s) ? s : null; };
        onEvent({ type: 'progress', percent: parseFloat(m[1]), speed: clean(m[2]), eta: clean(m[3]) });
        return;
      }
      const f = line.match(/^DCFILE:(.+)$/); // yt-dlp가 알려준 최종 파일 경로 (재다운로드 스킵도 찍힘)
      if (f) {
        jobFiles.push(f[1].trim());
        newCount++; onEvent({ type: 'progress', files: newCount });
        return;
      }
      if (tool === 'gallerydl') {
        // gallery-dl은 받은 파일 경로를 그대로, 이미 있던 파일은 '# 경로'로 찍는다
        const t = line.trim();
        const skipped = t.startsWith('# ');
        const p = skipped ? t.slice(2).trim() : t;
        if (path.isAbsolute(p) && fs.existsSync(p)) {
          jobFiles.push(p);
          if (!skipped) { newCount++; onEvent({ type: 'progress', files: newCount }); }
          return;
        }
      }
      if (/No module named/i.test(line)) info.noModule = true;
      if (UNSUPPORTED_RE.test(line)) info.unsupported = true;
      if (isErr || ERRORISH_RE.test(line)) {
        if (ERRORISH_RE.test(line)) info.lastError = line.trim();
        if (LOGIN_RE.test(line)) info.needsLogin = true;
      }
      onEvent({ type: 'log', line, isErr });
    };
    const outReader = createLineReader((l) => handleLine(l, false));
    const errReader = createLineReader((l) => handleLine(l, true));
    child.stdout.on('data', b => outReader.push(b));
    child.stderr.on('data', b => errReader.push(b));
    child.on('error', (e) => {
      if (opts.signal && opts.signal.aborted) { resolve({ ok: false, tool, canceled: true, count: 0, bytes: 0, thumb: null, file: null }); return; }
      onEvent({ type: 'error', line: String(e) });
      resolve({ ok: false, tool, code: -1, count: 0, bytes: 0, thumb: null, file: null, error: String(e) });
    });
    child.on('close', async (code) => {
      outReader.end(); errReader.end(); // 줄바꿈 없이 끝난 마지막 줄까지 처리
      const canceled = !!(opts.signal && opts.signal.aborted);
      // 이 작업의 출력에서 모은 파일로만 집계 → 동시 다운로드끼리 안 섞인다
      const all = [...new Set(jobFiles)].filter(p => { try { return fs.existsSync(p); } catch { return false; } });
      if (!all.length && code === 0 && !canceled) {
        // ponytail: 출력 형식을 못 알아본 사이트용 폴백(예전 시간창 스캔). 성공했을 때만 — 실패엔 안 써서 남의 파일을 안 줍는다
        const acc = { count: 0, bytes: 0, thumb: null, any: null, video: null };
        scanNew(outDir, startTime - 2000, acc);
        if (!acc.thumb && acc.video) acc.thumb = await extractThumb(acc.video);
        resolve({ ok: true, tool, code, canceled, count: acc.count, bytes: acc.bytes, thumb: acc.thumb, file: acc.any });
        return;
      }
      let bytes = 0;
      for (const p of all) { try { bytes += fs.statSync(p).size; } catch {} }
      let thumb = all.find(p => IMG_RE.test(p)) || null;
      const video = all.find(p => VID_RE.test(p));
      if (!thumb && video) thumb = await extractThumb(video);
      const result = { ok: code === 0 && !canceled, tool, code, canceled, count: all.length, bytes, thumb, file: all[0] || null };
      if (!result.ok && info.noModule) result.error = 'gallery-dl이 없어요 — ⚙ 설정의 [지금 모두 확인·업데이트]를 눌러 설치해 주세요';
      explainFailure(result, info);
      if (info.unsupported) result.unsupported = true;
      resolve(result);
    });
  });
}

// 영상 하나의 받을 수 있는 포맷 목록을 yt-dlp -J로 캐온다(화질·용량·썸네일). 확장 패널이 씀.
function classifyFmt(f) {
  const hasV = f.vcodec && f.vcodec !== 'none';
  const hasA = f.acodec && f.acodec !== 'none';
  if (hasV && hasA) return 'both';
  if (hasV) return 'video';
  if (hasA) return 'audio';
  return null; // 스토리보드/이미지 등은 버림
}

function probeFormats(url, opts) {
  opts = opts || {};
  const args = ['-J', '--no-warnings', '--no-playlist', '--encoding', 'utf-8'];
  if (opts.referer) args.push('--referer', opts.referer);
  if (opts.userAgent) args.push('--user-agent', opts.userAgent);
  args.push(...cookieArgs(null, opts.cookieFile));
  args.push(url);
  const signal = opts.signal || AbortSignal.timeout(30000); // 오래 걸리면 끊는다
  const run = resolveYtdlp();
  return new Promise((resolve) => {
    // 바이트로 모았다가 끝에서 한 번에 읽는다 — 조각 경계에서 한글 제목이 깨져 JSON 파싱이 실패하던 문제 방지
    const outChunks = [], errChunks = [];
    const child = spawn(run.cmd, [...run.pre, ...args], { windowsHide: true, signal, env: { ...process.env, ...TOOL_ENV } });
    child.stdout.on('data', d => outChunks.push(d));
    child.stderr.on('data', d => errChunks.push(d));
    child.on('error', (e) => resolve({ ok: false, error: e.name === 'AbortError' ? '시간 초과' : String(e) }));
    child.on('close', (code) => {
      const out = decodeLine(Buffer.concat(outChunks));
      const err = decodeLine(Buffer.concat(errChunks));
      if (code !== 0) { resolve({ ok: false, error: (err.trim().split(/\r?\n/).pop() || ('yt-dlp 오류 ' + code)) }); return; }
      let d; try { d = JSON.parse(out); } catch { resolve({ ok: false, error: '포맷 정보 파싱 실패' }); return; }
      const video = [], audio = [];
      for (const f of (d.formats || [])) {
        const kind = classifyFmt(f);
        if (!kind) continue;
        const item = { id: f.format_id, ext: f.ext, size: f.filesize || f.filesize_approx || null,
          approx: !f.filesize && !!f.filesize_approx, fps: f.fps || null, height: f.height || null,
          tbr: f.tbr || null, abr: f.abr || null, both: kind === 'both' };
        (kind === 'audio' ? audio : video).push(item);
      }
      video.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
      audio.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
      resolve({ ok: true, title: d.title || '', thumbnail: d.thumbnail || null, duration: d.duration || null, video, audio });
    });
  });
}

module.exports = {
  download, pickTool, isDirectFileUrl, isImageHost, expandListing, extractItemLinks, resolveEmbeddedSource,
  ytdlpArgs, gallerydlArgs, probeFormats, decodeLine, createLineReader, setBinDir, setThumbsDir, LOGIN_HINT,
  _setToolOverrides, // 테스트 전용
};

// 터미널에서 직접 실행: node engine.js <URL> [auto|video|image]
if (require.main === module) {
  const url = process.argv[2];
  const mode = process.argv[3] || 'auto';
  const cookies = process.argv[4] || null; // chrome|edge|firefox
  const cookieFile = process.env.COOKIEFILE || null; // cookies.txt 경로
  if (!url) { console.error('사용법: node engine.js <URL> [auto|video|image] [chrome|edge|firefox]  (쿠키파일은 COOKIEFILE=경로)'); process.exit(2); }
  download(url, { mode, cookies, cookieFile }, (e) => {
    if (e.type === 'progress' && e.percent != null) process.stdout.write(`\r진행률: ${e.percent}% ${e.speed || ''} ${e.eta ? '남은 ' + e.eta : ''}   `);
    else if (e.type === 'progress' && e.files != null) process.stdout.write(`\r받은 파일: ${e.files}개   `);
    else if (e.type === 'start') console.log(`[${e.tool}] 시작: ${e.url}`);
    else if (e.type === 'log' && e.isErr) console.error(e.line);
    else if (e.type === 'done') console.log(`\n끝 (code=${e.code})`);
  }).then(r => process.exit(r.ok ? 0 : 1));
}
