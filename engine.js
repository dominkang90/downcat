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
let _python;
function getPython() {
  if (_python) return _python;
  try {
    const out = execFileSync('where', ['python'], { encoding: 'utf8' });
    const exe = out.split(/\r?\n/).find(l => l.trim().toLowerCase().endsWith('.exe'));
    _python = exe ? exe.trim() : 'python';
  } catch { _python = 'python'; }
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

// yt-dlp 실행 인자 만들기.
function ytdlpArgs(url, outDir, cookies, cookieFile) {
  const ff = findFfmpeg();
  const args = [
    '--newline',
    '--progress-template', 'DLPCT:%(progress._percent_str)s',
    '-o', path.join(outDir, '%(extractor)s', '%(uploader)s', '%(title)s [%(id)s].%(ext)s'),
  ];
  if (ff !== null) args.push('-f', 'bv*+ba/b'); else args.push('-f', 'b');
  if (ff) args.push('--ffmpeg-location', ff);
  args.push(...cookieArgs(cookies, cookieFile));
  args.push(url);
  return args;
}

// gallery-dl 실행 인자 (python -m gallery_dl ...)
function gallerydlArgs(url, outDir, cookies, cookieFile) {
  const args = ['-m', 'gallery_dl', '-d', outDir];
  args.push(...cookieArgs(cookies, cookieFile));
  args.push(url);
  return args;
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
  if (tool === 'ytdlp') { cmd = YTDLP; args = ytdlpArgs(url, outDir, opts.cookies, opts.cookieFile); }
  else { cmd = getPython(); args = gallerydlArgs(url, outDir, opts.cookies, opts.cookieFile); }

  onEvent({ type: 'start', tool, url });

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let files = 0;
    const handle = (buf, isErr) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        const m = line.match(/DLPCT:\s*([\d.]+)%/); // yt-dlp 진행률
        if (m) { onEvent({ type: 'progress', percent: parseFloat(m[1]) }); continue; }
        if (tool === 'gallerydl' && /[\\/]/.test(line) && !line.startsWith('[')) {
          files++; onEvent({ type: 'progress', files }); // 파일 하나 받음
        }
        onEvent({ type: 'log', line, isErr });
      }
    };
    child.stdout.on('data', b => handle(b, false));
    child.stderr.on('data', b => handle(b, true));
    child.on('error', (e) => { onEvent({ type: 'error', line: String(e) }); resolve({ ok: false, tool, error: String(e) }); });
    child.on('close', (code) => {
      onEvent({ type: 'done', code });
      resolve({ ok: code === 0, tool, code });
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
    if (e.type === 'progress' && e.percent != null) process.stdout.write(`\r진행률: ${e.percent}%   `);
    else if (e.type === 'progress' && e.files != null) process.stdout.write(`\r받은 파일: ${e.files}개   `);
    else if (e.type === 'start') console.log(`[${e.tool}] 시작: ${e.url}`);
    else if (e.type === 'log' && e.isErr) console.error(e.line);
    else if (e.type === 'done') console.log(`\n끝 (code=${e.code})`);
  }).then(r => process.exit(r.ok ? 0 : 1));
}
