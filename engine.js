'use strict';
// 받냥이 다운로드 엔진: URL을 보고 yt-dlp(영상) 또는 gallery-dl(이미지)로 넘겨 받는다.
// GUI(main.js)에서 require 해서 쓰고, 터미널에서 `node engine.js <URL>`로도 쓴다.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN_DIR = path.join(__dirname, 'bin');
const YTDLP = fs.existsSync(path.join(BIN_DIR, 'yt-dlp.exe'))
  ? path.join(BIN_DIR, 'yt-dlp.exe')
  : 'yt-dlp';

// ffmpeg가 있으면 화질 좋은 영상+소리 합치기, 없으면 단일 파일(best)로 안전하게.
// ponytail: 물리 환경 보정 knob. bin/ffmpeg.exe 넣으면 자동으로 고화질 경로 탄다.
function findFfmpeg() {
  const local = path.join(BIN_DIR, 'ffmpeg.exe');
  if (fs.existsSync(local)) return BIN_DIR;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return ''; } // PATH에 있음
  catch { return null; } // 없음
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

// 이미지 갤러리 사이트는 gallery-dl로. 나머지(영상 포함, 모르는 곳)는 yt-dlp로.
const IMAGE_HOSTS = /(?:instagram\.com|pinterest\.|pixiv\.net|hitomi\.la|nhentai\.|e-hentai\.|exhentai\.|danbooru\.|gelbooru\.|deviantart\.com|tumblr\.com|imgur\.com|flickr\.com|artstation\.com|weibo\.)/i;

function pickTool(url, mode) {
  if (mode === 'video') return 'ytdlp';
  if (mode === 'image') return 'gallerydl';
  return IMAGE_HOSTS.test(url) ? 'gallerydl' : 'ytdlp'; // auto
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
  const args = [
    '--newline',
    '--progress-template', 'DLPCT:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    // 받은(또는 이미 있던) 파일의 최종 경로를 한 줄씩 찍게 한다 → 집계가 옆 작업과 안 섞임
    '--print', 'after_move:DCFILE:%(filepath)s', '--no-simulate',
    '-o', path.join(outDir, '%(extractor)s', '%(uploader)s', '%(title)s [%(id)s].%(ext)s'),
  ];
  const h = o.ytHeight ? `[height<=${o.ytHeight}]` : '';
  if (ff !== null) args.push('-f', `bv*${h}+ba/b${h}/b`); else args.push('-f', `b${h}/b`);
  if (ff) args.push('--ffmpeg-location', ff);
  if (o.thumbnail) args.push('--write-thumbnail');
  if (o.rateLimit) args.push('--limit-rate', o.rateLimit);
  args.push(...cookieArgs(o.cookies, o.cookieFile));
  args.push(url);
  return args;
}

// gallery-dl 실행 인자 (python -m gallery_dl ...)
function gallerydlArgs(url, outDir, o) {
  const args = ['-m', 'gallery_dl', '-d', outDir];
  if (/instagram\.com/i.test(url)) {
    // 파일명 보기 좋게: 계정_날짜_게시물코드_순번
    args.push('-f', '{username}_{post_date:%Y-%m-%d}_{post_shortcode}_{num:>02}.{extension}');
    if (o.stories) args.push('-o', 'include=posts,reels,stories,highlights'); // 스토리도 포함
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
const THUMBS_DIR = path.join(__dirname, 'thumbs');
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

/**
 * URL 하나를 받는다.
 * onEvent({type, percent?, line?, code?}) 로 진행 상황을 알려준다.
 * 반환: Promise -> {ok, tool, code}
 */
function download(url, opts, onEvent) {
  opts = opts || {};
  onEvent = onEvent || (() => {});
  const outDir = opts.outDir || path.join(__dirname, 'downloads');
  fs.mkdirSync(outDir, { recursive: true });
  const tool = pickTool(url, opts.mode || 'auto');

  let cmd, args;
  if (tool === 'ytdlp') { cmd = YTDLP; args = ytdlpArgs(url, outDir, opts); }
  else {
    cmd = getPython(); args = gallerydlArgs(url, outDir, opts);
    if (!cmd) { // 진짜 python 없음 → 스토어 창 대신 이유를 알려주고 바로 실패
      const msg = '파이썬이 없어요 — python.org에서 설치 후 pip install gallery-dl';
      onEvent({ type: 'error', line: msg });
      return Promise.resolve({ ok: false, tool, code: -1, count: 0, bytes: 0, thumb: null, file: null, error: msg });
    }
  }

  onEvent({ type: 'start', tool, url });
  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, signal: opts.signal });
    const jobFiles = []; let newCount = 0; // 이 작업의 출력에서 직접 모은 파일 목록
    let noModule = false; // 'No module named gallery_dl' 감지
    const handle = (buf, isErr) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        const m = line.match(/DLPCT:\s*([\d.]+)%\|([^|]*)\|(.*)/); // yt-dlp 진행률|속도|남은시간
        if (m) {
          const clean = (s) => { s = s.trim(); return s && !/unknown|^n\/?a$/i.test(s) ? s : null; };
          onEvent({ type: 'progress', percent: parseFloat(m[1]), speed: clean(m[2]), eta: clean(m[3]) });
          continue;
        }
        const f = line.match(/^DCFILE:(.+)$/); // yt-dlp가 알려준 최종 파일 경로 (재다운로드 스킵도 찍힘)
        if (f) {
          jobFiles.push(f[1].trim());
          newCount++; onEvent({ type: 'progress', files: newCount });
          continue;
        }
        if (tool === 'gallerydl') {
          // gallery-dl은 받은 파일 경로를 그대로, 이미 있던 파일은 '# 경로'로 찍는다
          const t = line.trim();
          const skipped = t.startsWith('# ');
          const p = skipped ? t.slice(2).trim() : t;
          if (/^[a-z]:[\\/]/i.test(p) && fs.existsSync(p)) {
            jobFiles.push(p);
            if (!skipped) { newCount++; onEvent({ type: 'progress', files: newCount }); }
            continue;
          }
        }
        if (/No module named/i.test(line)) noModule = true;
        onEvent({ type: 'log', line, isErr });
      }
    };
    child.stdout.on('data', b => handle(b, false));
    child.stderr.on('data', b => handle(b, true));
    child.on('error', (e) => {
      if (opts.signal && opts.signal.aborted) { onEvent({ type: 'done', canceled: true }); resolve({ ok: false, tool, canceled: true }); return; }
      onEvent({ type: 'error', line: String(e) }); resolve({ ok: false, tool, error: String(e) });
    });
    child.on('close', async (code) => {
      const canceled = !!(opts.signal && opts.signal.aborted);
      // 이 작업의 출력에서 모은 파일로만 집계 → 동시 다운로드끼리 안 섞인다
      const all = [...new Set(jobFiles)].filter(p => { try { return fs.existsSync(p); } catch { return false; } });
      if (!all.length && code === 0 && !canceled) {
        // ponytail: 출력 형식을 못 알아본 사이트용 폴백(예전 시간창 스캔). 성공했을 때만 — 실패엔 안 써서 남의 파일을 안 줍는다
        const acc = { count: 0, bytes: 0, thumb: null, any: null, video: null };
        scanNew(outDir, startTime - 2000, acc);
        if (!acc.thumb && acc.video) acc.thumb = await extractThumb(acc.video);
        const result = { ok: true, tool, code, canceled, count: acc.count, bytes: acc.bytes, thumb: acc.thumb, file: acc.any };
        onEvent({ type: 'done', ...result });
        resolve(result); return;
      }
      let bytes = 0;
      for (const p of all) { try { bytes += fs.statSync(p).size; } catch {} }
      let thumb = all.find(p => IMG_RE.test(p)) || null;
      const video = all.find(p => VID_RE.test(p));
      if (!thumb && video) thumb = await extractThumb(video);
      const result = { ok: code === 0 && !canceled, tool, code, canceled, count: all.length, bytes, thumb, file: all[0] || null };
      if (!result.ok && noModule) result.error = 'gallery-dl이 없어요 — 터미널에서 pip install gallery-dl';
      onEvent({ type: 'done', ...result });
      resolve(result);
    });
  });
}

module.exports = { download, pickTool };

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
