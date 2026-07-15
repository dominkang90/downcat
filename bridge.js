'use strict';
// 받냥이 로컬 브리지: 브라우저 확장이 던진 다운로드 요청을 받아 받냥이 창에 넘긴다.
// 127.0.0.1 전용 + 토큰으로 보호한다. 이 파일은 순수 함수(파싱·검사)와 서버 생성으로 나뉜다.
const http = require('http');

// /add 요청 본문(JSON 문자열)을 검사해 안전한 job으로 바꾼다. 순수 함수 — 테스트로 검증한다.
function parseAddBody(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return { error: 'JSON 파싱 실패' }; }
  if (!data || typeof data.url !== 'string') return { error: 'url 없음' };
  let u;
  try { u = new URL(data.url); } catch { return { error: 'url 형식 오류' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'http/https만 허용' };
  const job = { url: data.url, mode: (data.mode === 'video' || data.mode === 'image') ? data.mode : 'auto' };
  // referer는 http(s)일 때만 받는다(javascript: 같은 위험한 값 차단)
  if (typeof data.referer === 'string' && /^https?:\/\//i.test(data.referer)) job.referer = data.referer;
  return { job };
}

// 브라우저에서 온 요청이면 확장(chrome-extension://)만 허용. Origin이 없으면(curl 등 비브라우저) 허용.
function isAllowedOrigin(origin) {
  return origin === undefined || origin.startsWith('chrome-extension://');
}

const HOST = '127.0.0.1';   // 루프백 전용 — 외부에서 접근 불가(보안 핵심)
const PORT = 47653;
const MAX_BODY = 64 * 1024; // 본문 상한 64KB

// 확장이 던진 요청을 받는 서버를 만든다. onJob(job)이 창에 전달 성공하면 true.
function createBridgeServer({ token, onJob }) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    // 확장 요청이면 CORS 헤더를 붙인다(Private Network Access 프리플라이트 포함)
    const setCors = () => {
      if (origin && isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET');
        res.setHeader('Access-Control-Allow-Headers', 'content-type, x-downcat-token');
      }
    };
    const send = (code, obj) => { setCors(); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'OPTIONS') { setCors(); res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/ping') { send(200, { ok: true, app: 'downcat' }); return; }
    if (req.method === 'POST' && req.url === '/add') {
      if (origin && !isAllowedOrigin(origin)) { send(403, { ok: false, error: 'origin 거부' }); return; }
      if (req.headers['x-downcat-token'] !== token) { send(403, { ok: false, error: '토큰 불일치' }); return; }
      let body = ''; let tooBig = false;
      req.on('data', (c) => { body += c; if (body.length > MAX_BODY) { tooBig = true; req.destroy(); } });
      req.on('end', () => {
        if (tooBig) return;
        const parsed = parseAddBody(body);
        if (parsed.error) { send(400, { ok: false, error: parsed.error }); return; }
        const delivered = onJob(parsed.job);
        if (delivered) send(200, { ok: true }); else send(503, { ok: false, error: '받냥이 창이 준비 안 됨' });
      });
      return;
    }
    send(404, { ok: false, error: 'not found' });
  });
  // ponytail: 포트 점유 시 앱이 죽지 않게 에러만 로그(확장은 연결 실패로 감지). 재바인드는 안 함.
  server.on('error', (e) => console.error('[bridge] 포트 열기 실패:', e.message));
  server.listen(PORT, HOST);
  return server;
}

// 📌 이 코드가 하는 일: 받냥이 안에 아주 작은 우체통(127.0.0.1:47653)을 연다. 확장이 여기로 편지(POST /add)를 넣되 **열쇠(토큰)**가 맞아야 접수하고, 맞으면 주문표를 창에 전달한다. `/ping`은 "받냥이 살아있어?" 확인용.

module.exports = { parseAddBody, isAllowedOrigin, createBridgeServer };
