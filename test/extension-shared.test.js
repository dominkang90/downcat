'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { browserDownloadable, siteFolder, versionLess } = require('../extension/shared');
const { createBridgeServer } = require('../bridge');

test('확장 단독: 직접 파일·사진만 브라우저가 받고, 스트림·blob·페이지 주소는 앱이 필요', () => {
  for (const [url, mode] of [['https://a.com/x.jpg', 'file'], ['https://a.com/v.mp4?sig=1', 'file'], ['http://a.com/p.png', 'image']]) {
    assert.equal(browserDownloadable(url, mode), true, url);
  }
  for (const [url, mode] of [
    ['https://a.com/live/index.m3u8', 'file'], ['https://a.com/v.mpd?x=1', 'file'], ['https://a.com/seg1.m4s', 'file'], // 조각 스트림
    ['https://a.com/v.mp4', 'video'], ['https://youtube.com/watch?v=1', 'auto'],                                       // yt-dlp가 필요한 방식
    ['blob:https://a.com/1234', 'file'], ['data:image/png;base64,AA', 'image'], ['', 'file'],
  ]) assert.equal(browserDownloadable(url, mode), false, url);
});

test('확장 단독: 저장 폴더는 보던 페이지의 사이트 이름, 경로로 쓸 수 없는 글자는 없음', () => {
  assert.equal(siteFolder('https://www.Example.com/post/1', 'https://cdn.other.net/a.jpg'), '받냥이/example.com');
  assert.equal(siteFolder(undefined, 'https://cdn.other.net/a.jpg'), '받냥이/cdn.other.net');   // 페이지를 모르면 파일 주소 기준
  assert.equal(siteFolder('chrome://extensions', 'https://a.com/x'), '받냥이/a.com');
  assert.equal(siteFolder('https://한글.kr/', 'https://a.com/x'), '받냥이/xn--bj0bj06e.kr');
  assert.equal(siteFolder('not a url', 'also bad'), '받냥이');
  for (const page of ['https://../x', 'https://a.com/../../etc', 'https://[::1]/x', 'https://a.com\\..\\x']) {
    assert.doesNotMatch(siteFolder(page, 'https://a.com/x'), /\.\.|[\\:*?"<>|]|\/$/, page);
  }
});

test('확장 버전 비교는 숫자 기준', () => {
  assert.equal(versionLess('0.2.0', '0.3.0'), true);
  assert.equal(versionLess('0.9.0', '0.10.0'), true);
  assert.equal(versionLess('0.3.0', '0.3.0'), false);
  assert.equal(versionLess('0.3.1', '0.3.0'), false);
});

test('/ping은 앱에 든 확장 버전을 알려 주고, 없으면 예전 응답 그대로', async () => {
  for (const [extVersion, want] of [['0.3.0', { ok: true, app: 'downcat', extVersion: '0.3.0' }], [undefined, { ok: true, app: 'downcat' }]]) {
    const server = createBridgeServer({ token: 't', onJob: () => true, extVersion, port: 0 });
    await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
    try { assert.deepEqual(await (await fetch(`http://127.0.0.1:${server.address().port}/ping`)).json(), want); }
    finally { await new Promise((r) => server.close(r)); }
  }
});
