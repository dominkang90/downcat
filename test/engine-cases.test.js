'use strict';
// 가짜 도구로 엔진의 경우별 동작을 시험한다: 성공 / 일부 실패 / 지원 안 함(→gallery-dl 재시도) / 로그인 필요
// + 한글 경로(cp949 출력, 줄 중간 끊김) + 자동 분배 목록.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../engine');

const FAKE = path.join(__dirname, 'fake-tool.js');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'downcat-cases-'));
const emptyBin = path.join(tmpRoot, 'bin'); fs.mkdirSync(emptyBin);

test.before(() => {
  engine.setBinDir(emptyBin); // 진짜 도구·ffmpeg를 안 쓰게
  engine._setToolOverrides({
    ytdlp: { cmd: process.execPath, pre: [FAKE, 'ytdlp'] },
    gallerydl: { cmd: process.execPath, pre: [FAKE, 'gallerydl'] },
  });
});
test.after(() => { engine._setToolOverrides({}); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

let n = 0;
const newOut = () => path.join(tmpRoot, `${++n} 한글 폴더`); // 저장 폴더에 한글을 넣는다
async function run(url, mode = 'auto') {
  const events = [];
  const r = await engine.download(url, { outDir: newOut(), mode }, (e) => events.push(e));
  return { r, events };
}
const statusOf = (r) => (r.canceled ? 'canceled' : r.ok ? 'done' : r.count > 0 ? 'partial' : 'fail'); // main.js와 같은 규칙

test('성공: 파일 2개, 한글 경로 그대로, done 이벤트는 한 번', async () => {
  const { r, events } = await run('https://video.example/ok');
  assert.strictEqual(statusOf(r), 'done');
  assert.strictEqual(r.tool, 'ytdlp');
  assert.strictEqual(r.count, 2);
  assert.ok(fs.existsSync(r.file) && r.file.includes('한글 폴더') && r.file.includes('고양이 사진'), r.file);
  assert.strictEqual(events.filter(e => e.type === 'done').length, 1);
  assert.ok(events.some(e => e.type === 'progress' && e.percent === 50));
});

test('일부 실패: 받은 1개는 세고(일부 받음), 폴더 열기 경로가 살아 있다', async () => {
  const { r } = await run('https://video.example/partial');
  assert.strictEqual(statusOf(r), 'partial');
  assert.strictEqual(r.count, 1);
  assert.ok(fs.existsSync(r.file));
  assert.ok(/404/.test(r.error), '마지막 오류 줄이 이유로 붙는다: ' + r.error);
  assert.ok(!r.needsLogin);
});

test('지원 안 함: yt-dlp가 "Unsupported URL"이면 gallery-dl로 다시 시도해 성공', async () => {
  const { r, events } = await run('https://unknown.example/unsupported');
  assert.strictEqual(statusOf(r), 'done');
  assert.strictEqual(r.tool, 'gallerydl');
  assert.strictEqual(r.fallbackFrom, 'ytdlp');
  assert.strictEqual(r.count, 2);
  assert.ok(events.some(e => e.type === 'log' && /gallery-dl로 다시 시도/.test(e.line)));
  assert.strictEqual(events.filter(e => e.type === 'done').length, 1);
});

test('지원 안 함(둘 다): 이해하기 쉬운 실패 이유', async () => {
  const { r } = await run('https://unknown.example/both/unsupported');
  assert.strictEqual(statusOf(r), 'fail');
  assert.match(r.error, /지원하지 않는 주소/);
});

test('지원 안 함이어도 사용자가 "영상"을 골랐으면 재시도하지 않는다', async () => {
  const { r } = await run('https://unknown.example/unsupported', 'video');
  assert.strictEqual(statusOf(r), 'fail');
  assert.strictEqual(r.tool, 'ytdlp');
  assert.ok(!r.fallbackFrom);
});

test('로그인 필요(yt-dlp 403): [🔑 로그인] 안내', async () => {
  const { r } = await run('https://video.example/login');
  assert.strictEqual(statusOf(r), 'fail');
  assert.strictEqual(r.needsLogin, true);
  assert.strictEqual(r.error, engine.LOGIN_HINT);
});

test('로그인 필요(gallery-dl 401): [🔑 로그인] 안내', async () => {
  const { r } = await run('https://www.instagram.com/login');
  assert.strictEqual(r.tool, 'gallerydl');
  assert.strictEqual(r.needsLogin, true);
  assert.match(r.error, /로그인/);
});

test('gallery-dl 성공: 한글 경로 파일 2개', async () => {
  const { r } = await run('https://www.instagram.com/p/ok');
  assert.strictEqual(statusOf(r), 'done');
  assert.strictEqual(r.count, 2);
  assert.ok(r.file.includes('한글 폴더'));
  assert.ok(/\.jpg$/.test(r.thumb), '이미지가 카드 썸네일이 된다');
});

for (const kind of ['video.example', 'www.instagram.com']) {
  test(`한글 경로: 도구가 cp949로 출력해도 다시 읽어 맞춘다 (${kind})`, async () => {
    const { r, events } = await run(`https://${kind}/cp949`);
    assert.strictEqual(statusOf(r), 'done');
    assert.strictEqual(r.count, 2);
    assert.ok(fs.existsSync(r.file) && r.file.includes('고양이 사진'));
    assert.ok(!r.file.includes('other-job'), '옆 작업 파일을 줍지 않는다');
    assert.ok(!events.some(e => e.type === 'log' && /�/.test(e.line)), '깨진 글자(�)가 없어야 한다');
  });

  test(`한글 경로: 한 줄이 글자 중간에서 끊겨 들어와도 맞춘다 (${kind})`, async () => {
    const { r } = await run(`https://${kind}/split`);
    assert.strictEqual(statusOf(r), 'done');
    assert.strictEqual(r.count, 1, '옆 작업 파일까지 세면 안 된다');
    assert.ok(r.file.endsWith(kind === 'video.example' ? '고양이 영상.mp4' : '고양이 영상.jpg'), r.file);
  });
}

test('줄 읽기: UTF-8·cp949·끊긴 조각·\\r\\n·마지막 줄', () => {
  const lines = [];
  const rd = engine.createLineReader((l) => lines.push(l));
  const utf = Buffer.from('가나다\r\n', 'utf8');
  rd.push(utf.subarray(0, 4)); rd.push(utf.subarray(4)); // '나' 중간에서 끊김
  rd.push(Buffer.from('c7d1b1db0a', 'hex'));             // cp949 '한글\n'
  rd.push(Buffer.from('끝', 'utf8'));                     // 줄바꿈 없이 끝남
  rd.end();
  assert.deepStrictEqual(lines, ['가나다', '한글', '끝']);
  assert.strictEqual(engine.decodeLine(Buffer.from('c7d1b1db', 'hex')), '한글');
});

test('자동 분배: 새 이미지 사이트와 호스트 이름 기준 판별', () => {
  const g = (u) => engine.pickTool(u, 'auto');
  for (const u of ['https://x.com/user/status/1', 'https://twitter.com/user/status/1', 'https://mobile.twitter.com/a',
    'https://blog.naver.com/abc/123', 'https://m.blog.naver.com/abc/123', 'https://bsky.app/profile/a.bsky.social/post/1',
    'https://www.behance.net/gallery/1/x', 'https://kr.pinterest.com/pin/1', 'https://www.pinterest.co.kr/pin/1',
    'https://instagram.com/p/abc', 'https://danbooru.donmai.us/posts/1']) {
    assert.strictEqual(g(u), 'gallerydl', u);
  }
  for (const u of ['https://www.youtube.com/watch?v=1&ref=instagram.com', 'https://box.com/x', 'https://naver.com/',
    'https://tv.naver.com/v/1', 'https://netflix.com/']) {
    assert.strictEqual(g(u), 'ytdlp', u);
  }
});

test('UTF-8 출력 옵션이 두 도구 인자에 들어간다', () => {
  const y = engine.ytdlpArgs('https://a.b/c', 'out', {});
  assert.strictEqual(y[y.indexOf('--encoding') + 1], 'utf-8');
  const gd = engine.gallerydlArgs('https://a.b/c', 'out', {});
  assert.ok(gd.includes('output.stdout=utf-8') && gd.includes('output.stderr=utf-8'));
});
