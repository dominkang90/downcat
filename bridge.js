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
  const mode = (data.mode === 'video' || data.mode === 'image' || data.mode === 'file') ? data.mode : 'auto';
  const job = { url: data.url, mode };
  // referer는 http(s)일 때만 받는다(javascript: 같은 위험한 값 차단)
  if (typeof data.referer === 'string' && /^https?:\/\//i.test(data.referer)) job.referer = data.referer;
  // User-Agent는 짧은 문자열만(확장이 navigator.userAgent를 그대로 넘김)
  if (typeof data.userAgent === 'string' && data.userAgent.length <= 512) job.userAgent = data.userAgent;
  // yt-dlp 포맷 지정(확장에서 고른 화질). 짧고 안전한 문자만 허용.
  if (typeof data.format === 'string' && data.format.length <= 100 && /^[\w+\-./:]+$/.test(data.format)) job.format = data.format;
  // 브라우저 쿠키(확장이 chrome.cookies.getAll로 모은 것) → 안전한 것만 골라 담는다
  const cookies = sanitizeCookies(data.cookies);
  if (cookies) job.cookies = cookies;
  return { job };
}

// 확장이 보낸 쿠키 배열에서 이름·값·도메인이 문자열인 것만 남긴다(main이 cookies.txt로 굽기 전 방어).
function sanitizeCookies(arr) {
  if (!Array.isArray(arr)) return undefined;
  const out = [];
  for (const c of arr) {
    if (!c || typeof c.domain !== 'string' || typeof c.name !== 'string' || typeof c.value !== 'string') continue;
    out.push({
      domain: c.domain,
      path: typeof c.path === 'string' ? c.path : '/',
      secure: !!c.secure,
      expirationDate: typeof c.expirationDate === 'number' ? c.expirationDate : undefined,
      name: c.name,
      value: c.value,
    });
    if (out.length >= 500) break; // ponytail: 상한 — 비정상 폭주 방지(본문 64KB 상한이 이미 1차 방어)
  }
  return out.length ? out : undefined;
}

// 브라우저에서 온 요청이면 확장(chrome-extension://)만 허용. Origin이 없으면(curl 등 비브라우저) 허용.
function isAllowedOrigin(origin) {
  return origin === undefined || origin.startsWith('chrome-extension://');
}

const HOST = '127.0.0.1';   // 루프백 전용 — 외부에서 접근 불가(보안 핵심)
const PORT = 47653;
const MAX_BODY = 64 * 1024; // 본문 상한 64KB

// 확장이 던진 요청을 받는 서버를 만든다. onJob(job)이 창에 전달 성공하면 true.
// onProbe(job) -> Promise<formats>: 영상 포맷 목록을 캐서 돌려준다(선택).
function createBridgeServer({ token, onJob, onProbe }) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    // 확장 요청이면 CORS 헤더를 붙인다(Private Network Access 프리플라이트 포함)
    const setCors = () => {
      if (origin !== undefined && isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET');
        res.setHeader('Access-Control-Allow-Headers', 'content-type, x-downcat-token');
      }
    };
    const send = (code, obj) => { setCors(); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'OPTIONS') { setCors(); res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/ping') { send(200, { ok: true, app: 'downcat' }); return; }
    // POST /add(다운로드 넣기) 와 /formats(포맷 목록 조회)는 같은 보안검사·본문읽기를 공유한다.
    if (req.method === 'POST' && (req.url === '/add' || req.url === '/formats')) {
      if (origin !== undefined && !isAllowedOrigin(origin)) { send(403, { ok: false, error: 'origin 거부' }); return; }
      if (req.headers['x-downcat-token'] !== token) { send(403, { ok: false, error: '토큰 불일치' }); return; }
      const chunks = []; let size = 0; let tooBig = false;
      req.on('data', (c) => {
        size += c.length;                                  // c는 Buffer → 바이트 길이(문자 수 아님)
        if (size > MAX_BODY) { tooBig = true; req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return;
        const body = Buffer.concat(chunks).toString('utf8'); // 끝에서 한 번만 디코드(멀티바이트 안전)
        const parsed = parseAddBody(body);
        if (parsed.error) { send(400, { ok: false, error: parsed.error }); return; }
        if (req.url === '/formats') {                       // 포맷 목록: onProbe가 yt-dlp로 캐온다
          if (!onProbe) { send(501, { ok: false, error: '포맷 조회 미지원' }); return; }
          Promise.resolve(onProbe(parsed.job))
            .then(r => send(200, r || { ok: false, error: '결과 없음' }))
            .catch(e => send(500, { ok: false, error: String((e && e.message) || e) }));
          return;
        }
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
