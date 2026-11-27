'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isNewer, releaseUrl, check } = require('../app-update');
const { importOldData } = require('../import-old');

test('새 버전 판단: 숫자 비교, 꼬리표 판은 정식판보다 낮음, 모르는 형식은 알리지 않음', () => {
  assert.equal(isNewer('v0.3.0', '0.2.8'), true);
  assert.equal(isNewer('v0.2.10', '0.2.9'), true);          // 글자 비교가 아니라 숫자 비교
  assert.equal(isNewer('v0.2.8', '0.2.7-youtube.1'), true);
  assert.equal(isNewer('v0.2.7', '0.2.7-youtube.1'), true);  // 같은 숫자면 정식판이 위
  assert.equal(isNewer('v0.2.0', '0.2.7-youtube.1'), false); // 지금 GitHub "최신"(v0.2.0)은 알리지 않는다
  assert.equal(isNewer('v0.2.8', '0.2.8'), false);
  for (const bad of ['', 'latest', '1.2', 'v1.2.3/../x', null]) assert.equal(isNewer(bad, '0.2.8'), false);
  assert.equal(releaseUrl('v0.3.0'), 'https://github.com/dominkang90/downcat/releases/tag/v0.3.0');
});

test('새 버전 확인: 태그만 읽고, 실패 응답은 오류', async () => {
  assert.deepEqual(await check(async () => new Response(JSON.stringify({ tag_name: 'v0.3.0', html_url: 'https://evil.example/' }))), { latest: 'v0.3.0' });
  await assert.rejects(check(async () => new Response('', { status: 403 })));
});

test('예전 폴더 가져오기: 아는 설정만, 기록은 합치고, 쿠키는 덮어쓰지 않음', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'downcat-import-'));
  try {
    const old = path.join(root, 'old'), cur = path.join(root, 'new');
    fs.mkdirSync(path.join(old, 'cookies'), { recursive: true });
    const oldCookie = path.join(old, 'cookies', 'cookies.txt');
    fs.writeFileSync(oldCookie, 'OLD');
    fs.writeFileSync(path.join(old, 'config.json'), JSON.stringify({ parallel: 3, rateLimit: '5M', cookieFile: oldCookie, bridgeToken: 'tok', evil: 'x', notify: 'yes', appUpdate: { latest: 'v9.9.9' } }));
    fs.writeFileSync(path.join(old, 'tasks.json'), JSON.stringify([{ id: 'a', at: '2026-01-02' }, { id: 'b', at: '2026-01-01' }, null, { at: 'no id' }]));
    const settings = { parallel: 1, rateLimit: '', cookieFile: null, notify: true, bridgeToken: 'new' };
    const cookiesTxt = path.join(cur, 'cookies', 'cookies.txt');
    const args = { settings, tasks: [{ id: 'b', at: '2026-01-01' }, { id: 'c', at: '2026-01-03' }], cookiesTxt, keys: Object.keys(settings) };

    const r = importOldData(old, args);
    assert.equal(r.settings.parallel, 3); assert.equal(r.settings.rateLimit, '5M'); assert.equal(r.settings.bridgeToken, 'tok');
    assert.equal(r.settings.notify, true);            // 형식이 다른 값은 받지 않는다
    assert.equal('evil' in r.settings, false); assert.equal('appUpdate' in r.settings, false);
    assert.equal(r.settings.cookieFile, cookiesTxt);  // 예전 폴더 안 쿠키를 가리키던 설정은 새 위치로
    assert.equal(r.cookie, true); assert.equal(fs.readFileSync(cookiesTxt, 'utf8'), 'OLD');
    assert.deepEqual(r.tasks.map(t => t.id), ['c', 'a', 'b']); assert.equal(r.taskCount, 1);
    assert.equal(settings.parallel, 1);               // 넘겨받은 설정 객체는 고치지 않는다

    fs.writeFileSync(cookiesTxt, 'CURRENT');
    assert.equal(importOldData(old, args).cookie, false);
    assert.equal(fs.readFileSync(cookiesTxt, 'utf8'), 'CURRENT'); // 지금 로그인은 지킨다
    assert.throws(() => importOldData(path.join(root, 'empty'), args), /찾지 못했어요/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
