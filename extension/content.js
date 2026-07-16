'use strict';
// 페이지의 각 <video>에 마우스를 올리면 그 위에 "받냥이로 받기" 목록 패널을 띄운다.
// 목록엔 페이지의 동영상들 + 배경이 감지한 스트림이 썸네일과 함께 나오고, 클릭하면 받냥이로 보낸다.

const Z = 2147483647;
const seen = new WeakSet();
let panel, listEl, hideTimer;

// 다운로드 URL·모드: 직접 http 영상 → aria2(file), blob/스트리밍 → 페이지를 yt-dlp(video)
function urlFor(video) {
  const s = video.currentSrc || video.src || '';
  return /^https?:\/\//i.test(s) ? { url: s, mode: 'file' } : { url: location.href, mode: 'video' };
}

// 썸네일: poster 우선(교차출처도 img로는 표시 OK), 없으면 현재 프레임 캡처(같은 출처만, 실패 시 null)
function thumbFor(video) {
  if (video.poster) return video.poster;
  try {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 72;
    c.getContext('2d').drawImage(video, 0, 0, 128, 72);
    return c.toDataURL('image/jpeg', 0.6);
  } catch { return null; } // 교차출처 영상은 캔버스가 오염돼 못 읽음 → 썸네일 생략
}

function ensurePanel() {
  if (panel) return;
  panel = document.createElement('div');
  panel.setAttribute('data-downcat', '1');
  Object.assign(panel.style, {
    position: 'fixed', zIndex: String(Z), display: 'none', maxHeight: '260px', overflowY: 'auto',
    background: 'rgba(20,20,22,.94)', color: '#fff', borderRadius: '10px', padding: '8px',
    font: '13px system-ui, sans-serif', boxShadow: '0 4px 18px rgba(0,0,0,.5)', width: '300px',
  });
  const title = document.createElement('div');
  title.textContent = '받냥이로 받기';
  Object.assign(title.style, { fontWeight: '700', margin: '2px 4px 6px', color: '#7fd6da' });
  listEl = document.createElement('div');
  panel.append(title, listEl);
  panel.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  panel.addEventListener('mouseleave', scheduleHide);
  document.body.appendChild(panel);
}

// 목록 한 줄(썸네일 + 이름 + 설명). 클릭하면 onClick.
function makeRow(thumb, label, sub, onClick) {
  const r = document.createElement('div');
  Object.assign(r.style, { display: 'flex', gap: '8px', alignItems: 'center', padding: '5px', borderRadius: '6px', cursor: 'pointer' });
  r.addEventListener('mouseenter', () => { r.style.background = 'rgba(255,255,255,.12)'; });
  r.addEventListener('mouseleave', () => { r.style.background = 'transparent'; });
  const th = document.createElement('div');
  Object.assign(th.style, { width: '56px', height: '32px', flex: 'none', borderRadius: '4px', background: '#333', backgroundSize: 'cover', backgroundPosition: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px' });
  if (thumb) th.style.backgroundImage = `url("${thumb}")`; else th.textContent = '🎬';
  const txt = document.createElement('div');
  txt.style.overflow = 'hidden';
  const name = document.createElement('div');
  name.textContent = label;
  Object.assign(name.style, { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
  const subEl = document.createElement('div');
  subEl.textContent = sub;
  Object.assign(subEl.style, { fontSize: '11px', color: '#9aa', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
  txt.append(name, subEl);
  r.append(th, txt);
  r.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    onClick();
    r.style.background = 'rgba(46,125,50,.55)';
    subEl.textContent = '받냥이로 보냈어요 ✅';
  });
  return r;
}

async function buildList() {
  listEl.textContent = '';
  const rows = [];
  const done = new Set();
  const add = (url, mode, thumb, label, sub) => {
    if (!url || done.has(url)) return; done.add(url);
    rows.push(makeRow(thumb, label, sub, () => chrome.runtime.sendMessage({ type: 'send', url, mode })));
  };
  // 페이지의 동영상들
  document.querySelectorAll('video').forEach((v, i) => {
    const { url, mode } = urlFor(v);
    const res = v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : (mode === 'video' ? '스트리밍(페이지로 받음)' : '');
    add(url, mode, thumbFor(v), `동영상 ${i + 1}`, res);
  });
  // 배경이 감지한 스트림들
  let streams = [];
  try { streams = await chrome.runtime.sendMessage({ type: 'getStreams' }); } catch {}
  for (const s of (streams || [])) {
    const isStream = /\.(m3u8|mpd|m4s)(\?|$)/i.test(s.url);
    add(s.url, isStream ? 'video' : 'file', null, isStream ? '스트림(HLS/DASH)' : (s.kind === 'audio' ? '오디오' : '동영상 파일'), (s.url.split('/').pop() || s.url).slice(0, 44));
  }
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.textContent = '받을 영상이 안 보여요 (재생을 시작한 뒤 다시 올려보세요).';
    Object.assign(empty.style, { padding: '8px', color: '#9aa' });
    listEl.appendChild(empty);
  } else {
    rows.forEach(r => listEl.appendChild(r));
  }
}

function showPanel(video) {
  ensurePanel();
  clearTimeout(hideTimer);
  buildList();
  const r = video.getBoundingClientRect();
  if (r.width < 120 || r.height < 80) return; // 너무 작은 영상/광고는 무시
  panel.style.left = Math.min(window.innerWidth - 312, Math.max(8, r.left + 8)) + 'px';
  panel.style.top = Math.max(8, r.top + 8) + 'px';
  panel.style.display = 'block';
}
function scheduleHide() { hideTimer = setTimeout(() => { if (panel) panel.style.display = 'none'; }, 500); }

function attach(v) {
  if (seen.has(v)) return; seen.add(v);
  v.addEventListener('mouseenter', () => showPanel(v));
  v.addEventListener('mouseleave', scheduleHide);
}
function scan() { document.querySelectorAll('video').forEach(attach); }

scan();
new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
// 스크롤하면 패널이 영상과 어긋나니 숨긴다(다시 올리면 나옴)
window.addEventListener('scroll', () => { if (panel) panel.style.display = 'none'; }, true);
