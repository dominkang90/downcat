'use strict';
// 확장 [연결하기](/pair)와 위장 요청 차단(Host 검사) 시험. 빈 포트를 써서 실제 받냥이와 안 부딪힌다.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createBridgeServer, isAllowedHost, extensionIdFromOrigin, extensionIdFromKey } = require('../bridge');

const EXT = 'chrome-extension://hcaehgnpahddjceeamipjimeokagpgno';

async function start(onPair) {
  const asked = [];
  const server = createBridgeServer({
    token: 'SECRET', port: 0, onJob: () => true,
    onPair: async (info) => { asked.push(info); return onPair(info); },
  });
  await new Promise((r) => server.once('listening', r));
  return { server, asked, port: server.address().port };
}

// fetch는 Host 헤더를 못 바꾸므로 http.request로 직접 보낸다
function req(port, { method = 'POST', path = '/pair', headers = {}, body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, json: d ? JSON.parse(d) : null }));
    });
    r.on('error', reject); r.end(body);
  });
}

test('[연결하기] → 받냥이에서 [예] → 토큰을 받는다', async () => {
  const { server, asked, port } = await start(() => true);
  try {
    const r = await req(port, { headers: { origin: EXT } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { ok: true, token: 'SECRET' });
    assert.deepStrictEqual(asked, [{ extensionId: 'hcaehgnpahddjceeamipjimeokagpgno', origin: EXT }]);
  } finally { server.close(); }
});

test('[아니요]면 토큰을 안 주고, 잠깐은 다시 못 묻는다(확인창 도배 방지)', async () => {
  const { server, asked, port } = await start(() => false);
  try {
    const r1 = await req(port, { headers: { origin: EXT } });
    assert.strictEqual(r1.status, 403);
    assert.ok(!('token' in r1.json));
    const r2 = await req(port, { headers: { origin: EXT } });
    assert.strictEqual(r2.status, 429);
    assert.strictEqual(asked.length, 1);
  } finally { server.close(); }
});

test('확인창이 떠 있는 동안 또 오면 429(확인창은 하나만)', async () => {
  let answer;
  const { server, asked, port } = await start(() => new Promise((r) => { answer = r; }));
  try {
    const first = req(port, { headers: { origin: EXT } });
    await new Promise((r) => setTimeout(r, 50));
    const second = await req(port, { headers: { origin: EXT } });
    assert.strictEqual(second.status, 429);
    answer(true);
    assert.strictEqual((await first).status, 200);
    assert.strictEqual(asked.length, 1);
  } finally { server.close(); }
});

test('확장이 아닌 곳(웹페이지·Origin 없음)은 연결 요청 자체가 안 된다', async () => {
  const { server, asked, port } = await start(() => true);
  try {
    assert.strictEqual((await req(port, { headers: { origin: 'https://evil.com' } })).status, 403);
    assert.strictEqual((await req(port)).status, 403, 'Origin 없는 요청(curl 등)도 [연결하기]는 불가');
    assert.strictEqual((await req(port, { headers: { origin: 'chrome-extension://short' } })).status, 403);
    assert.strictEqual(asked.length, 0, '확인창도 안 뜬다');
  } finally { server.close(); }
});

test('위장 요청 차단: Host가 우리 주소가 아니면 모든 요청 거부(DNS 리바인딩)', async () => {
  const { server, asked, port } = await start(() => true);
  try {
    const evil = { host: `evil.example:${port}` };
    assert.strictEqual((await req(port, { headers: { ...evil, origin: EXT } })).status, 403);
    assert.strictEqual((await req(port, { method: 'GET', path: '/ping', headers: evil, body: '' })).status, 403);
    assert.strictEqual((await req(port, { path: '/add', headers: { ...evil, 'x-downcat-token': 'SECRET' }, body: JSON.stringify({ url: 'https://a.b/c' }) })).status, 403);
    assert.strictEqual((await req(port, { method: 'GET', path: '/ping', headers: { host: `localhost:${port}` }, body: '' })).status, 200);
    assert.strictEqual(asked.length, 0);
  } finally { server.close(); }
});

test('기존 토큰 방식은 그대로 동작', async () => {
  const { server, port } = await start(() => true);
  try {
    const ok = await req(port, { path: '/add', headers: { origin: EXT, 'x-downcat-token': 'SECRET' }, body: JSON.stringify({ url: 'https://a.b/c' }) });
    assert.strictEqual(ok.status, 200);
    const bad = await req(port, { path: '/add', headers: { origin: EXT, 'x-downcat-token': 'WRONG' }, body: JSON.stringify({ url: 'https://a.b/c' }) });
    assert.strictEqual(bad.status, 403);
  } finally { server.close(); }
});

test('도우미 함수: Host·확장 ID', () => {
  assert.ok(isAllowedHost('127.0.0.1:47653', 47653));
  assert.ok(isAllowedHost('LOCALHOST:47653', 47653));
  assert.ok(!isAllowedHost('127.0.0.1:1', 47653));
  assert.ok(!isAllowedHost('127.0.0.1.evil.com:47653', 47653));
  assert.ok(!isAllowedHost(undefined, 47653));
  assert.strictEqual(extensionIdFromOrigin(EXT), 'hcaehgnpahddjceeamipjimeokagpgno');
  assert.strictEqual(extensionIdFromOrigin('https://x.com'), null);
  assert.strictEqual(extensionIdFromKey(require('../extension/manifest.json').key), 'hcaehgnpahddjceeamipjimeokagpgno',
    '공식 확장 ID를 manifest key로 계산(README의 ID와 같음)');
});
