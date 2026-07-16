'use strict';
// 팝업: 받냥이 연결 상태 + 리소스 수집기(이 페이지의 동영상·이미지·오디오를 골라 일괄 전송).
const BRIDGE = 'http://127.0.0.1:47653';
const $ = (id) => document.getElementById(id);
let activeTab = null;

// 종류 → 표시(이모지+이름) + 전송 모드. 스트림만 yt-dlp(video), 나머지 직링은 aria2(file).
const KIND = {
  stream: { icon: '🎬', name: '스트림', mode: 'video' },
  video:  { icon: '🎞️', name: '동영상', mode: 'file' },
  audio:  { icon: '🎵', name: '오디오', mode: 'file' },
  image:  { icon: '🖼️', name: '이미지', mode: 'file' },
};
function modeFor(item) {
  return /\.(m3u8|mpd|m4s)(\?|$)/i.test(item.url) ? 'video' : (KIND[item.kind] || {}).mode || 'file';
}

// 연결 상태(/ping)
(async () => {
  try {
    const res = await fetch(`${BRIDGE}/ping`);
    const data = await res.json().catch(() => ({}));
    setConn(res.ok && data.app === 'downcat' ? '받냥이 연결됨 ✅' : '응답 이상', res.ok);
  } catch { setConn('받냥이 꺼짐 — 먼저 실행', false); }
})();

$('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('page').addEventListener('click', async () => {
  const tab = await getTab();
  if (!tab || !tab.url) return;
  chrome.runtime.sendMessage({ type: 'send', url: tab.url, mode: 'auto', tab });
  window.close();
});

$('all').addEventListener('click', () => setAll(true));
$('none').addEventListener('click', () => setAll(false));
$('refresh').addEventListener('click', loadResources);
$('send').addEventListener('click', sendChecked);

// 페이지가 열리자마자 리소스 수집
loadResources();

async function getTab() {
  if (activeTab) return activeTab;
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab;
}

// DOM에서 이미지·영상·오디오 주소를 긁는다(탭 안에서 실행됨).
function scrapeDom() {
  const out = [];
  const push = (url, kind) => { if (url && /^https?:/i.test(url)) out.push({ url, kind }); };
  document.querySelectorAll('img[src]').forEach((e) => push(e.currentSrc || e.src, 'image'));
  document.querySelectorAll('video[src]').forEach((e) => push(e.src, 'video'));
  document.querySelectorAll('video source[src]').forEach((e) => push(e.src, 'video'));
  document.querySelectorAll('audio[src], audio source[src]').forEach((e) => push(e.src, 'audio'));
  return out;
}

async function loadResources() {
  $('list').innerHTML = '<div class="empty">불러오는 중…</div>';
  const tab = await getTab();
  if (!tab) { $('list').innerHTML = '<div class="empty">탭을 못 찾음</div>'; return; }

  const streams = await chrome.runtime.sendMessage({ type: 'getStreams', tabId: tab.id }).catch(() => []);
  let dom = [];
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeDom });
    dom = (r && r.result) || [];
  } catch { /* 특수페이지(chrome://)엔 주입 불가 — 무시 */ }

  // url로 중복 제거
  const map = new Map();
  for (const it of [...(streams || []), ...dom]) {
    if (!it || !/^https?:\/\//i.test(it.url)) continue;
    if (!map.has(it.url)) map.set(it.url, it);
  }
  render([...map.values()]);
}

function render(items) {
  const list = $('list');
  if (!items.length) { list.innerHTML = '<div class="empty">감지된 미디어 없음 — 영상을 재생하거나 새로고침 하세요.</div>'; $('send').disabled = true; return; }
  // 스트림·동영상 먼저 보이게 정렬
  const order = { stream: 0, video: 1, audio: 2, image: 3 };
  items.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  list.innerHTML = '';
  for (const it of items) {
    const k = KIND[it.kind] || { icon: '📄', name: '파일' };
    const row = document.createElement('label');
    row.className = 'item';
    row.innerHTML = `<input type="checkbox" checked><span class="k">${k.icon}</span><span class="u"></span>`;
    row.querySelector('.u').textContent = it.url;
    row.querySelector('.u').title = it.url;
    row._item = it;
    list.appendChild(row);
  }
  updateSendState();
  list.addEventListener('change', updateSendState);
}

function setAll(on) { document.querySelectorAll('#list input[type=checkbox]').forEach((c) => (c.checked = on)); updateSendState(); }
function updateSendState() { $('send').disabled = ![...document.querySelectorAll('#list input:checked')].length; }

async function sendChecked() {
  const tab = await getTab();
  const rows = [...document.querySelectorAll('#list .item')].filter((r) => r.querySelector('input').checked);
  for (const r of rows) chrome.runtime.sendMessage({ type: 'send', url: r._item.url, mode: modeFor(r._item), tab });
  window.close();
}

function setConn(msg, ok) { const c = $('conn'); c.textContent = msg; c.style.color = ok ? '#2e7d32' : '#c62828'; }
