'use strict';
// 받냥이 확장 서비스워커: 우클릭 "받냥이로 받기" → URL + 그 사이트 쿠키 + referer + UA를
// 받냥이 로컬 브리지(127.0.0.1:47653)로 POST 한다. 토큰은 확장 옵션에서 저장한 값을 쓴다.

const BRIDGE = 'http://127.0.0.1:47653';
const MENU_ID = 'downcat-send';

// 설치/업데이트 때 우클릭 메뉴를 만든다(링크·이미지·영상·오디오에서 보임).
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '받냥이로 받기',
    contexts: ['link', 'image', 'video', 'audio'],
  });
});

// ---- 동영상/미디어 스트림 감지: 탭마다 오간 미디어 요청 URL을 모은다(팝업 "리소스 수집기"용) ----
// ponytail: 서비스워커가 잠들면 목록이 비워짐(메모리 Map). 페이지가 재생되면 다시 잡히니 감수.
const streamsByTab = new Map(); // tabId -> Map<url, {url, kind}>
const STREAM_RE = /\.(m3u8|mpd|m4s)(\?|$)/i;                 // HLS/DASH 조각 스트림 → yt-dlp
const VIDEO_RE = /\.(mp4|webm|mkv|mov|m4v|avi|ts)(\?|$)/i;
const AUDIO_RE = /\.(mp3|m4a|aac|flac|wav|ogg|opus)(\?|$)/i;

function classifyUrl(url) {
  if (STREAM_RE.test(url)) return 'stream';
  if (VIDEO_RE.test(url)) return 'video';
  if (AUDIO_RE.test(url)) return 'audio';
  return null;
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0 || !/^https?:/i.test(d.url)) return;
    const kind = classifyUrl(d.url);
    if (!kind) return;
    let m = streamsByTab.get(d.tabId);
    if (!m) { m = new Map(); streamsByTab.set(d.tabId, m); }
    if (!m.has(d.url)) m.set(d.url, { url: d.url, kind });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }
);

// 새 페이지로 이동하면 그 탭의 목록을 비운다(옛 페이지 미디어가 안 섞이게)
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) streamsByTab.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => streamsByTab.delete(tabId));

// 팝업의 "이 페이지 보내기"·"리소스 수집기"가 배경과 대화한다(토큰·쿠키·referer 로직 재사용).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'send' && msg.url) { sendToDowncat(msg.url, msg.mode || 'auto', msg.tab); return; }
  if (msg.type === 'getStreams') {
    const m = streamsByTab.get(msg.tabId);
    sendResponse(m ? [...m.values()] : []); // 동기 응답
    return;
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  // 링크를 우클릭했으면 그 링크, 미디어면 그 미디어 주소
  const url = info.linkUrl || info.srcUrl;
  if (!url) { flash('보낼 주소를 못 찾음'); return; }
  // 링크는 가속 파일로(aria2), 미디어는 엔진이 판단(auto: 직링→aria2, m3u8→yt-dlp)
  const mode = info.linkUrl ? 'file' : 'auto';
  sendToDowncat(url, mode, tab);
});

// 토큰: 사용자가 옵션에 저장한 값(local) 우선, 없으면 설치기가 넣은 정책값(managed).
async function getToken() {
  const { token } = await chrome.storage.local.get('token');
  if (token) return token;
  try { const m = await chrome.storage.managed.get('bridgeToken'); return m.bridgeToken || ''; } catch { return ''; }
}

async function sendToDowncat(url, mode, tab) {
  const token = await getToken();
  if (!token) { flash('토큰 없음 — 확장 옵션에서 붙여넣기'); return; }

  let cookies = [];
  try { cookies = await chrome.cookies.getAll({ url }); } catch { /* 쿠키 못 읽어도 그냥 진행 */ }

  const referer = tab && tab.url && /^https?:/i.test(tab.url) ? tab.url : undefined;
  const body = JSON.stringify({ url, mode, referer, userAgent: navigator.userAgent, cookies });

  try {
    const res = await fetch(`${BRIDGE}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Downcat-Token': token },
      body,
    });
    if (res.ok) flash('받냥이에 보냈어요 ✅', '✓');
    else if (res.status === 403) flash('토큰이 안 맞아요 — 옵션에서 다시');
    else if (res.status === 503) flash('받냥이 창을 먼저 켜주세요');
    else flash('전송 실패: ' + res.status);
  } catch {
    flash('받냥이가 안 켜져 있어요 (먼저 실행)');
  }
}

// ponytail: notifications 권한 대신 툴바 배지+툴팁으로 가볍게 알린다(4초 뒤 지움).
function flash(msg, badge) {
  chrome.action.setBadgeText({ text: badge || '!' });
  chrome.action.setBadgeBackgroundColor({ color: badge ? '#2e7d32' : '#c62828' });
  chrome.action.setTitle({ title: '받냥이: ' + msg });
  setTimeout(() => { chrome.action.setBadgeText({ text: '' }); chrome.action.setTitle({ title: '받냥이' }); }, 4000);
}
