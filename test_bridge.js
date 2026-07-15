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
