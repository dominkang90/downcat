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

console.log('ok - aria2Args, parseAria2Progress, routing');
