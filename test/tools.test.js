'use strict';
// 도구 자동 설치·업데이트 시험: 가짜 GitHub에 실제와 같은 저장소·파일 이름·해시 출처를 차려 놓고 돌린다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createToolManager, TOOL_SPECS, parseSums, DAY, toolsFor } = require('../tools');
const { makeZip, startFakeGithub, sha256 } = require('./helpers');

const FF_ZIP = 'ffmpeg-master-latest-win64-gpl.zip';
const ARIA_137 = 'aria2-1.37.0-win-64bit-build1.zip';

// 실제 배포와 같은 모양의 릴리스 한 벌
function standardReleases(gh, v = 1) {
  const yt = Buffer.from(`fake yt-dlp v${v}`);
  gh.releases['yt-dlp/yt-dlp'] = { tag_name: `2026.10.${10 + v}`, assets: [
    { name: 'yt-dlp.exe', data: yt },
    { name: 'SHA2-256SUMS', data: Buffer.from(`${sha256(Buffer.from('other'))}  yt-dlp\n${sha256(yt)}  yt-dlp.exe\n`) },
  ] };
  gh.releases['gdl-org/builds'] = { tag_name: `2026.10.${20 + v}`, body: `gallery-dl commit ${v}`, assets: [
    { name: 'gallery-dl_windows.exe', data: Buffer.from(`fake gallery-dl v${v}`), digest: true },
    { name: 'gallery-dl_windows_x86.exe', data: Buffer.from('x86'), digest: true },
  ] };
  const ff = makeZip({
    'ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe': Buffer.from(`fake ffmpeg v${v} `.repeat(5000)),
    'ffmpeg-master-latest-win64-gpl/bin/ffprobe.exe': Buffer.from(`fake ffprobe v${v}`),
    'ffmpeg-master-latest-win64-gpl/bin/ffplay.exe': Buffer.from('ffplay'),
    'ffmpeg-master-latest-win64-gpl/LICENSE.txt': Buffer.from('GPL'),
  });
  gh.releases['yt-dlp/FFmpeg-Builds'] = { tag_name: 'latest', published_at: `2026-10-${10 + v}T00:00:00Z`, assets: [
    { name: FF_ZIP, data: ff },
    { name: 'ffmpeg-master-latest-win64-gpl-shared.zip', data: Buffer.from('shared') },
    { name: 'checksums.sha256', data: Buffer.from(`${sha256(Buffer.from('shared'))}  ffmpeg-master-latest-win64-gpl-shared.zip\r\n${sha256(ff)}  ${FF_ZIP}\r\n`) },
  ] };
  const aria = makeZip({ [`aria2-1.38.${v}-win-64bit-build1/aria2c.exe`]: Buffer.from(`fake aria2c v${v}`) });
  gh.releases['aria2/aria2'] = { tag_name: `release-1.38.${v}`, assets: [
    { name: `aria2-1.38.${v}-win-64bit-build1.zip`, data: aria, digest: true },
    { name: `aria2-1.38.${v}-win-32bit-build1.zip`, data: Buffer.from('32'), digest: true },
  ] };
}

let gh;
test.beforeEach(async () => { gh = await startFakeGithub(); });
test.afterEach(() => gh.close());

function mk(extra = {}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downcat-tools-'));
  let clock = Date.parse('2026-10-22T00:00:00Z');
  const m = createToolManager({ binDir, enabled: true, apiBase: gh.base, now: () => clock, ...extra });
  return { m, binDir, read: (f) => fs.readFileSync(path.join(binDir, f), 'utf8'), has: (f) => fs.existsSync(path.join(binDir, f)),
    advance: (ms) => { clock += ms; } };
}

test('첫 실행: 네 도구를 받아 해시 확인 후 설치(ffmpeg는 ffmpeg·ffprobe만 꺼냄)', async () => {
  standardReleases(gh);
  const { m, read, has, binDir } = mk();
  const r = await m.checkAll();
  assert.deepStrictEqual(r.map(x => [x.name, x.result]), [['ytdlp', 'installed'], ['gallerydl', 'installed'], ['aria2', 'installed'], ['ffmpeg', 'installed']]);
  assert.strictEqual(read('yt-dlp.exe'), 'fake yt-dlp v1');
  assert.strictEqual(read('gallery-dl.exe'), 'fake gallery-dl v1');
  assert.strictEqual(read('aria2c.exe'), 'fake aria2c v1');
  assert.ok(read('ffmpeg.exe').startsWith('fake ffmpeg v1'));
  assert.strictEqual(read('ffprobe.exe'), 'fake ffprobe v1');
  assert.ok(!has('ffplay.exe'), '필요 없는 파일은 안 꺼낸다');
  const st = JSON.parse(read('tools.json'));
  assert.strictEqual(st.ytdlp.version, '2026.10.11');
  assert.strictEqual(st.aria2.version, '1.38.1');
  assert.strictEqual(st.ffmpeg.version, '빌드 2026-10-11', 'ffmpeg 태그는 늘 latest라 빌드 날짜를 보여준다');
  assert.match(st.ytdlp.sha256, /^[0-9a-f]{64}$/);
  assert.ok(m.snapshot().every(t => t.status === 'ok' && !t.error));
  assert.deepStrictEqual(fs.readdirSync(path.join(binDir, '.downcat-tmp')), [], '임시 파일이 남지 않는다');
});

test('해시가 원본과 다르면 설치하지 않는다', async () => {
  standardReleases(gh);
  const yt = gh.releases['yt-dlp/yt-dlp'];
  yt.assets[1].data = Buffer.from(`${'0'.repeat(64)}  yt-dlp.exe\n`); // 해시 목록이 다른 값을 말함
  const { m, has } = mk();
  const r = await m.checkAll();
  const y = r.find(x => x.name === 'ytdlp');
  assert.strictEqual(y.result, 'error');
  assert.match(y.error, /해시가 원본과 달라서 설치하지 않았어요/);
  assert.ok(!has('yt-dlp.exe'));
  assert.strictEqual(m.snapshot().find(t => t.name === 'ytdlp').status, 'error');
  assert.strictEqual(r.find(x => x.name === 'gallerydl').result, 'installed', '다른 도구는 계속 설치된다');
});

test('해시를 구할 곳이 없으면 설치하지 않는다(gallery-dl에 GitHub digest 없음)', async () => {
  standardReleases(gh);
  gh.releases['gdl-org/builds'].assets[0].digest = false;
  const { m, has } = mk();
  const r = await m.checkAll();
  assert.match(r.find(x => x.name === 'gallerydl').error, /원본 해시를 구할 곳이 없어/);
  assert.ok(!has('gallery-dl.exe'));
  assert.ok(!gh.hits.dl['gallery-dl_windows.exe'], '해시가 없으면 받지도 않는다');
});

test('해시 출처끼리 값이 다르면 설치하지 않는다(해시 목록 ≠ GitHub digest)', async () => {
  standardReleases(gh);
  gh.releases['yt-dlp/yt-dlp'].assets[0].digest = 'sha256:' + 'a'.repeat(64);
  const { m, has } = mk();
  const r = await m.checkAll();
  assert.match(r.find(x => x.name === 'ytdlp').error, /해시 출처끼리 값이 달라서/);
  assert.ok(!has('yt-dlp.exe'));
});

test('aria2 1.37.0: GitHub digest가 없으면 코드에 고정한 해시로 확인 — 다른 파일이면 거부', async () => {
  standardReleases(gh);
  gh.releases['aria2/aria2'] = { tag_name: 'release-1.37.0', assets: [
    { name: ARIA_137, data: makeZip({ 'aria2-1.37.0-win-64bit-build1/aria2c.exe': Buffer.from('가짜') }) },
  ] };
  assert.ok(TOOL_SPECS.aria2.pinned[ARIA_137], '진짜 1.37.0 해시가 고정돼 있다');
  const { m, has } = mk();
  const r = await m.checkAll();
  assert.match(r.find(x => x.name === 'aria2').error, /해시가 원본과 달라서/);
  assert.ok(!has('aria2c.exe'));
});

test('하루 안에는 다시 확인하지 않고, 하루 지나면 새 버전으로 바꿔 끼운다(ffmpeg는 30일)', async () => {
  standardReleases(gh, 1);
  const { m, read, advance, binDir } = mk();
  await m.checkAll();
  const apiAfterInstall = gh.hits.api;

  standardReleases(gh, 2); // 새 버전 나옴
  advance(12 * 3600 * 1000);
  let r = await m.checkAll();
  assert.ok(r.every(x => x.result === 'skipped'), '12시간 뒤: 확인 안 함');
  assert.strictEqual(gh.hits.api, apiAfterInstall);

  advance(13 * 3600 * 1000); // 총 25시간
  r = await m.checkAll();
  const res = Object.fromEntries(r.map(x => [x.name, x.result]));
  assert.deepStrictEqual(res, { ytdlp: 'updated', gallerydl: 'updated', aria2: 'updated', ffmpeg: 'skipped' });
  assert.strictEqual(read('yt-dlp.exe'), 'fake yt-dlp v2');
  assert.ok(read('ffmpeg.exe').startsWith('fake ffmpeg v1'), 'ffmpeg는 아직 그대로');
  assert.ok(!fs.readdirSync(binDir).some(f => /\.old-/.test(f)), '옛 파일은 지워진다');

  advance(30 * DAY); // ffmpeg 기한 지남 → 빌드(해시)가 바뀌었으니 받는다
  r = await m.checkAll();
  assert.strictEqual(r.find(x => x.name === 'ffmpeg').result, 'updated');
  assert.ok(read('ffmpeg.exe').startsWith('fake ffmpeg v2'));
});

test('ffmpeg는 빌드가 같으면(해시 같음) 다시 받지 않는다', async () => {
  standardReleases(gh, 1);
  const { m, advance } = mk();
  await m.checkAll();
  assert.strictEqual(gh.hits.dl[FF_ZIP], 1);
  advance(31 * DAY);
  const r = await m.checkAll();
  assert.strictEqual(r.find(x => x.name === 'ffmpeg').result, 'latest');
  assert.strictEqual(gh.hits.dl[FF_ZIP], 1, '200MB를 또 받지 않는다');
});

test('[지금 모두 확인·업데이트]: 기한과 상관없이 ffmpeg까지 바로 확인', async () => {
  standardReleases(gh, 1);
  const { m, read } = mk();
  await m.checkAll();
  standardReleases(gh, 2);
  const r = await m.checkAll({ force: true });
  assert.ok(r.every(x => x.result === 'updated'), JSON.stringify(r));
  assert.ok(read('ffmpeg.exe').startsWith('fake ffmpeg v2'));
});

test('설치 중에 넣은 작업은 기다렸다가 받는다(없는 도구 설치 동안 whenReady가 안 풀림)', async () => {
  standardReleases(gh);
  gh.hold('yt-dlp.exe'); // yt-dlp 받는 응답을 붙잡아 "설치 중" 상태로 만든다
  const { m, has } = mk();
  const all = m.checkAll();
  assert.strictEqual(m.isReady(toolsFor('ytdlp')), false);
  assert.strictEqual(m.isReady(['ffmpeg']), false, 'ffmpeg도 없으니 막혀 있다');
  let started = false;
  const job = m.whenReady(['ytdlp']).then(() => { started = true; assert.ok(has('yt-dlp.exe'), '풀릴 때는 설치가 끝나 있다'); });
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(started, false, '설치가 안 끝났으니 아직 시작 안 함');
  gh.release('yt-dlp.exe');
  await job;
  assert.strictEqual(started, true);
  await all;
  assert.ok(m.isReady());
});

test('이미 있는 도구의 업데이트는 받는 동안 작업을 막지 않는다', async () => {
  standardReleases(gh, 1);
  const { m, advance, read } = mk();
  await m.checkAll();
  standardReleases(gh, 2);
  advance(DAY + 1);
  gh.hold('yt-dlp.exe');
  const all = m.checkAll();
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(m.snapshot().find(t => t.name === 'ytdlp').status, 'downloading');
  assert.strictEqual(m.isReady(['ytdlp']), true, '옛 yt-dlp로 계속 받을 수 있다');
  gh.release('yt-dlp.exe');
  await all;
  assert.strictEqual(read('yt-dlp.exe'), 'fake yt-dlp v2');
});

test('손으로 넣어 둔 도구(기록 없음): ffmpeg는 바로 갈아끼우지 않고, 나머지는 확인한다', async () => {
  standardReleases(gh);
  const { m, binDir, read } = mk();
  fs.writeFileSync(path.join(binDir, 'ffmpeg.exe'), 'old ffmpeg');
  fs.writeFileSync(path.join(binDir, 'ffprobe.exe'), 'old ffprobe');
  fs.writeFileSync(path.join(binDir, 'yt-dlp.exe'), 'old yt-dlp');
  const r = Object.fromEntries((await m.checkAll()).map(x => [x.name, x.result]));
  assert.strictEqual(r.ffmpeg, 'skipped');
  assert.strictEqual(read('ffmpeg.exe'), 'old ffmpeg', '켤 때마다 200MB를 받지 않는다');
  assert.strictEqual(r.ytdlp, 'updated', '버전을 알 수 없는 yt-dlp는 최신으로');
  assert.strictEqual(read('yt-dlp.exe'), 'fake yt-dlp v1');
});

test('같은 확인이 겹치면 한 번만 돈다', async () => {
  standardReleases(gh);
  const { m } = mk();
  const a = m.checkAll(), b = m.checkAll({ force: true });
  assert.strictEqual(a, b);
  await a;
  assert.strictEqual(gh.hits.dl['yt-dlp.exe'], 1);
});

test('GitHub 확인이 실패하면 오류로 남기고 기존 도구는 그대로', async () => {
  standardReleases(gh);
  const { m, binDir } = mk({ apiBase: gh.base + '/nope' });
  fs.writeFileSync(path.join(binDir, 'yt-dlp.exe'), 'old');
  const r = await m.checkAll();
  assert.ok(r.every(x => x.result === 'error' || x.result === 'skipped'));
  assert.strictEqual(fs.readFileSync(path.join(binDir, 'yt-dlp.exe'), 'utf8'), 'old');
  assert.strictEqual(m.snapshot().find(t => t.name === 'ytdlp').status, 'ok', '있는 도구는 계속 쓸 수 있음');
  assert.ok(m.isReady(), '실패해도 작업이 영원히 기다리지 않는다');
});

test('Windows가 아니면 자동 설치를 끈다', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downcat-tools-'));
  const m = createToolManager({ binDir, enabled: false, apiBase: gh.base });
  assert.deepStrictEqual(await m.start(), []);
  assert.ok(m.snapshot().every(t => t.status === 'manual'));
  assert.strictEqual(gh.hits.api, 0);
});

test('해시 목록 읽기: *이름, CRLF, 대소문자', () => {
  const h = 'A'.repeat(64);
  assert.strictEqual(parseSums(`${h} *yt-dlp.exe\r\n`, 'yt-dlp.exe'), 'a'.repeat(64));
  assert.strictEqual(parseSums(`${h}  yt-dlp\n`, 'yt-dlp.exe'), null);
});

test('실제 설정: 저장소와 파일 이름이 기대한 것', () => {
  assert.strictEqual(TOOL_SPECS.ytdlp.repo, 'yt-dlp/yt-dlp');
  assert.strictEqual(TOOL_SPECS.ffmpeg.repo, 'yt-dlp/FFmpeg-Builds');
  assert.ok(TOOL_SPECS.ffmpeg.asset.test(FF_ZIP), '지금 쓰는 yt-dlp용 빌드 그대로');
  assert.ok(!TOOL_SPECS.ffmpeg.asset.test('ffmpeg-master-latest-win64-gpl-shared.zip'));
  assert.ok(TOOL_SPECS.gallerydl.asset.test('gallery-dl_windows.exe'));
  assert.ok(!TOOL_SPECS.gallerydl.asset.test('gallery-dl_windows_x86.exe'));
  assert.ok(TOOL_SPECS.aria2.asset.test(ARIA_137));
  assert.ok(!TOOL_SPECS.aria2.asset.test('aria2-1.37.0-win-32bit-build1.zip'));
  assert.strictEqual(TOOL_SPECS.ffmpeg.interval, 30 * DAY);
});
