'use strict';
// 실제 yt-dlp·gallery-dl로 한글 경로를 확인한다(내 컴퓨터의 로컬 테스트 서버만 씀 — 인터넷 안 씀).
// 한국어 Windows처럼 파이썬 출력 기본값을 cp949로 만들어 두고(PYTHONIOENCODING=cp949) 돌린다.
// 도구가 없으면(bin에도 PATH에도) 건너뛴다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, execFile } = require('child_process');
const execFileAsync = (cmd, args, opts) => new Promise((res, rej) =>
  execFile(cmd, args, { ...opts, encoding: 'buffer' }, (e, out) => (e ? rej(e) : res(out))));
const engine = require('../engine');

const BIN = path.join(__dirname, '..', 'bin');
function findTool(name) {
  for (const f of [name + '.exe', name]) { const p = path.join(BIN, f); if (fs.existsSync(p)) return p; }
  try { execFileSync(name, ['--version'], { stdio: 'ignore' }); return name; } catch { return null; }
}
const YTDLP = findTool('yt-dlp');
const GDL = findTool('gallery-dl');

let server, base, tmp;
test.before(async () => {
  engine.setBinDir(BIN);
  engine._setToolOverrides({});
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'downcat-real-'));
  server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url);
    if (u.startsWith('/page')) { // 영상 2개가 박힌 페이지. 두 번째는 없는 파일 → yt-dlp가 "일부 실패"로 끝난다
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>한글 제목</title></head><body><video src="/a.mp4"></video><video src="/missing.mp4"></video></body></html>');
    } else if (u === '/a.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(Buffer.alloc(4096, 1));
    } else if (u.endsWith('.jpg')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2000, 48)]));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.PYTHONIOENCODING; });

test('재현: 옵션 없이 cp949로 찍힌 실제 yt-dlp 경로는 UTF-8로 읽으면 깨지고, 엔진 디코더로는 맞다', { skip: !YTDLP && 'yt-dlp 없음' }, async () => {
  const want = path.join(tmp, '한글 폴더', 'x.mp4');
  const raw = await execFileAsync(YTDLP, ['--simulate', '--print', 'filename', '-o', want, `${base}/a.mp4`],
    { env: { ...process.env, PYTHONIOENCODING: 'cp949' } });
  const line = raw.subarray(0, raw.indexOf(0x0a));
  assert.notStrictEqual(line.toString('utf8'), want, '버그 재현: UTF-8로 읽으면 깨져야 한다');
  assert.strictEqual(engine.decodeLine(line), want);
});

test('실제 yt-dlp: 한글 폴더 + 일부 실패에서도 받은 파일 수·폴더 열기가 맞다', { skip: !YTDLP && 'yt-dlp 없음' }, async () => {
  process.env.PYTHONIOENCODING = 'cp949'; // 한국어 Windows 흉내(엔진이 utf-8로 덮어써야 함)
  const outDir = path.join(tmp, '받냥이 한글 업로더');
  const r = await engine.download(`${base}/page`, { outDir, mode: 'video' }, () => {});
  delete process.env.PYTHONIOENCODING;
  assert.strictEqual(r.ok, false, '두 번째 영상이 없으니 일부 실패');
  assert.strictEqual(r.count, 1, '받은 1개를 세야 한다(고치기 전엔 0개 = 실패로 보였음)');
  assert.ok(r.file && fs.existsSync(r.file) && r.file.startsWith(outDir), String(r.file));
  assert.ok(r.file.includes('한글 제목'));
});

test('실제 gallery-dl: 한글 폴더·한글 파일 이름', { skip: !GDL && 'gallery-dl 없음' }, async () => {
  process.env.PYTHONIOENCODING = 'cp949';
  const outDir = path.join(tmp, '갤러리 한글');
  const r = await engine.download(`${base}/${encodeURIComponent('고양이 사진')}.jpg`, { outDir, mode: 'image' }, () => {});
  delete process.env.PYTHONIOENCODING;
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.count, 1);
  assert.ok(fs.existsSync(r.file) && r.file.includes('고양이 사진'), String(r.file));
  assert.strictEqual(r.thumb, r.file);
});
