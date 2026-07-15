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
  return !origin || origin.startsWith('chrome-extension://');
}

module.exports = { parseAddBody, isAllowedOrigin };
