'use strict';
const assert = require('assert');
const { parseAddBody, isAllowedOrigin } = require('./bridge');

// 1) 정상 body: url + mode + referer
let r = parseAddBody(JSON.stringify({ url: 'https://ex.com/a.zip', mode: 'auto', referer: 'https://ex.com/' }));
assert.deepStrictEqual(r.job, { url: 'https://ex.com/a.zip', mode: 'auto', referer: 'https://ex.com/' });

// 2) mode 생략 → auto, referer 생략 → 키 없음
r = parseAddBody(JSON.stringify({ url: 'https://ex.com/a.zip' }));
assert.strictEqual(r.job.mode, 'auto');
assert.strictEqual('referer' in r.job, false);

// 3) mode 이상값 → auto로 정규화
assert.strictEqual(parseAddBody(JSON.stringify({ url: 'https://ex.com/a', mode: 'wat' })).job.mode, 'auto');
assert.strictEqual(parseAddBody(JSON.stringify({ url: 'https://ex.com/a', mode: 'video' })).job.mode, 'video');

// 4) 나쁜 입력 → error
assert(parseAddBody('{not json').error);
assert(parseAddBody(JSON.stringify({})).error);                       // url 없음
assert(parseAddBody(JSON.stringify({ url: 'ftp://x/y' })).error);     // http/https 아님
assert(parseAddBody(JSON.stringify({ url: 'not a url' })).error);

// 5) referer가 http(s) 아니면 무시(키 없음, 에러는 아님)
r = parseAddBody(JSON.stringify({ url: 'https://ex.com/a', referer: 'javascript:alert(1)' }));
assert.strictEqual('referer' in r.job, false);

// 6) Origin 검사: 확장만 허용, Origin 없으면(curl 등) 허용, 웹페이지 Origin 거부
assert.strictEqual(isAllowedOrigin('chrome-extension://abcd'), true);
assert.strictEqual(isAllowedOrigin(undefined), true);
assert.strictEqual(isAllowedOrigin('https://evil.com'), false);

console.log('ok - parseAddBody, isAllowedOrigin');

// ---- http 레벨 테스트: 진짜 서버를 띄워 보안 게이트(토큰·origin·바이트상한·라우트)를 검증한다 ----
(async () => {
  const { createBridgeServer } = require('./bridge');

  let onJobCalled = false;
  const server = createBridgeServer({
    token: 'T',
    onJob: () => { onJobCalled = true; return true; },
  });

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const BASE = 'http://127.0.0.1:47653';
  const failures = [];
  const check = (cond, label) => { if (!cond) failures.push(label); };

  try {
    // 1) 정상 토큰 + 작은 정상 body → 200, onJob 호출됨
    onJobCalled = false;
    let res = await fetch(`${BASE}/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-downcat-token': 'T' },
      body: JSON.stringify({ url: 'https://ex.com/a.zip' }),
    });
    check(res.status === 200, '1) 정상 토큰+body → 200 아님');
    check(onJobCalled === true, '1) onJob 호출 안 됨');

    // 2) 토큰 헤더 없음 → 403, onJob 호출 안 됨
    onJobCalled = false;
    res = await fetch(`${BASE}/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://ex.com/a.zip' }),
    });
    check(res.status === 403, '2) 토큰 없음 → 403 아님');
    check(onJobCalled === false, '2) onJob 호출됨(안 되어야 함)');

    // 3) 정상 토큰 + 악성 Origin → 403 (origin 게이트가 토큰보다 우선), onJob 호출 안 됨
    onJobCalled = false;
    res = await fetch(`${BASE}/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-downcat-token': 'T', origin: 'https://evil.com' },
      body: JSON.stringify({ url: 'https://ex.com/a.zip' }),
    });
    check(res.status === 403, '3) 악성 origin → 403 아님');
    check(onJobCalled === false, '3) onJob 호출됨(안 되어야 함)');

    // 4) 정상 토큰 + 64KB 넘는 멀티바이트 body → 200이 아니어야 함(연결 리셋), onJob 호출 안 됨
    //    (바이트 기준 상한 회귀 가드: 문자 수 기준으로 되돌아가면 이 케이스가 실패한다)
    onJobCalled = false;
    let case4Not200 = true;
    try {
      const bigReferer = 'https://ex.com/?q=' + '가'.repeat(30000); // 한글 1자 = utf8 3바이트 → 약 90KB
      res = await fetch(`${BASE}/add`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-downcat-token': 'T' },
        body: JSON.stringify({ url: 'https://ex.com/a.zip', referer: bigReferer }),
      });
      case4Not200 = res.status !== 200;
    } catch {
      case4Not200 = true; // fetch가 소켓 리셋으로 예외를 던지는 것도 정상(=거부됨)
    }
    check(case4Not200, '4) 64KB 초과 멀티바이트 body가 200으로 통과함(바이트 상한 회귀)');
    check(onJobCalled === false, '4) onJob 호출됨(안 되어야 함)');

    // 5) GET /ping (토큰 없이) → 200, body {"ok":true,"app":"downcat"}
    res = await fetch(`${BASE}/ping`);
    const pingBody = await res.text();
    check(res.status === 200, '5) /ping → 200 아님');
    check(pingBody === JSON.stringify({ ok: true, app: 'downcat' }), '5) /ping body 불일치: ' + pingBody);

    // 6) GET /nope → 404
    res = await fetch(`${BASE}/nope`);
    check(res.status === 404, '6) /nope → 404 아님');
  } catch (e) {
    failures.push(`예외 발생: ${e.message}`);
  } finally {
    server.close();
  }

  if (failures.length) {
    process.exitCode = 1;
    console.error('FAIL - bridge server gates:', failures.join(' | '));
  } else {
    console.log('ok - bridge server gates');
  }
})();
