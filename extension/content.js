'use strict';
// 각 <video> 위(우측 상단)에 "받냥이" 버튼을 띄운다. 누르면 받을 수 있는 포맷(영상/오디오 탭,
// 화질·용량·썸네일)을 보여주고 고른 걸 받냥이로 받는다. yt-dlp가 못 읽는 곳은 간단 목록으로 폴백.

const Z = 2147483647;
const seen = new WeakSet();
let btn, panel, head, tabsEl, listEl, activeVideo, hideTimer;

/* 유틸 */
function el(tag, style, text) { const e = document.createElement(tag); if (style) Object.assign(e.style, style); if (text != null) e.textContent = text; return e; }
function fmtSize(n) { if (!n) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0, v = n; while (v >= 1024 && i < 3) { v /= 1024; i++; } return (v < 10 ? v.toFixed(1) : Math.round(v)) + u[i]; }
function send(url, mode, format) { return chrome.runtime.sendMessage({ type: 'send', url, mode, format }).catch(() => ({ ok: false, error: '확장 오류' })); }

/* 영상 위 버튼 */
function ensureButton() {
  if (btn) return;
  btn = el('button', { position: 'fixed', zIndex: String(Z), display: 'none', cursor: 'pointer',
    background: 'rgba(43,155,163,.95)', color: '#fff', border: 'none', borderRadius: '6px',
    padding: '5px 9px', font: '600 12px system-ui,sans-serif', boxShadow: '0 2px 8px rgba(0,0,0,.45)' }, '⬇ 받냥이');
  btn.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  btn.addEventListener('mouseleave', scheduleHide);
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPanel(); });
  document.body.appendChild(btn);
}
function showButton(video) {
  ensureButton(); clearTimeout(hideTimer); activeVideo = video;
  const r = video.getBoundingClientRect();
  if (r.width < 160 || r.height < 100) { btn.style.display = 'none'; return; } // 작은 영상/광고 제외
  btn.style.left = Math.min(window.innerWidth - 92, r.right - 92) + 'px';
  btn.style.top = Math.max(4, r.top + 8) + 'px';
  btn.style.display = 'block';
}
function scheduleHide() { hideTimer = setTimeout(hideAll, 600); }
function hideAll() { if (panel && panel.matches(':hover')) return; if (btn) btn.style.display = 'none'; if (panel) panel.style.display = 'none'; }

/* 패널 */
function ensurePanel() {
  if (panel) return;
  panel = el('div', { position: 'fixed', zIndex: String(Z), display: 'none', width: '320px',
    background: 'rgba(20,20,22,.96)', color: '#fff', borderRadius: '10px',
    font: '13px system-ui,sans-serif', boxShadow: '0 6px 22px rgba(0,0,0,.55)' });
  head = el('div', { display: 'flex', gap: '8px', padding: '8px', alignItems: 'center' });
  tabsEl = el('div', { display: 'flex', gap: '6px', padding: '0 8px 6px' });
  listEl = el('div', { maxHeight: '230px', overflowY: 'auto', padding: '0 6px 8px' });
  panel.append(head, tabsEl, listEl);
  panel.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  panel.addEventListener('mouseleave', scheduleHide);
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(panel);
}
function positionPanel() {
  const r = activeVideo.getBoundingClientRect();
  panel.style.left = Math.min(window.innerWidth - 332, Math.max(8, r.right - 320)) + 'px';
  panel.style.top = Math.max(8, r.top + 8) + 'px';
}

async function openPanel() {
  ensurePanel(); positionPanel();
  head.textContent = ''; tabsEl.textContent = ''; listEl.textContent = '';
  head.append(el('div', { padding: '6px', color: '#9aa' }, '받을 수 있는 화질 불러오는 중…'));
  panel.style.display = 'block';
  const url = location.href;
  const res = await chrome.runtime.sendMessage({ type: 'probe', url }).catch(() => ({ ok: false, error: '확장 오류' }));
  renderPanel(res, url);
}

function makeHeader(thumb, title) {
  head.textContent = '';
  const t = el('div', { width: '86px', height: '48px', flex: 'none', borderRadius: '5px', background: '#333',
    backgroundSize: 'cover', backgroundPosition: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px' });
  if (thumb) t.style.backgroundImage = `url("${thumb}")`; else t.textContent = '🎬';
  const ti = el('div', { fontWeight: '700', lineHeight: '1.25', maxHeight: '48px', overflow: 'hidden' }, title || '받냥이로 받기');
  head.append(t, ti);
}

// 한 줄(화질/이름 + 용량). 클릭하면 onClick()의 결과를 표시.
function row(label, sub, onClick) {
  const r = el('div', { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center',
    padding: '7px 8px', borderRadius: '6px', cursor: 'pointer' });
  r.addEventListener('mouseenter', () => { r.style.background = 'rgba(255,255,255,.12)'; });
  r.addEventListener('mouseleave', () => { r.style.background = 'transparent'; });
  const L = el('div', { fontWeight: '600' }, label);
  const S = el('div', { fontSize: '12px', color: '#9aa', textAlign: 'right', whiteSpace: 'nowrap' }, sub);
  r.append(L, S);
  r.addEventListener('click', async () => {
    S.textContent = '보내는 중…';
    const res = await onClick();
    if (res && res.ok) { r.style.background = 'rgba(46,125,50,.55)'; S.textContent = res.via === 'browser' ? '받는 중 ⬇' : '받냥이로 ✅'; }
    else { r.style.background = 'rgba(198,40,40,.5)'; S.textContent = (res && res.error) || '실패'; }
  });
  return r;
}

function renderPanel(res, pageUrl) {
  head.textContent = ''; tabsEl.textContent = ''; listEl.textContent = '';
  if (!res || !res.ok) { // yt-dlp가 못 읽는 곳 → 간단 폴백
    makeHeader(activeVideo.poster || null, (res && res.error) || '포맷을 못 읽었어요');
    fallbackList(pageUrl);
    return;
  }
  makeHeader(res.thumbnail || activeVideo.poster, res.title);
  const V = res.video || [], A = res.audio || [];
  const tabV = tabButton('영상 ' + V.length), tabA = tabButton('오디오 ' + A.length);
  tabsEl.append(tabV, tabA);
  tabV.addEventListener('click', () => { setActive(tabV, tabA); fillVideo(V, pageUrl); });
  tabA.addEventListener('click', () => { setActive(tabA, tabV); fillAudio(A, pageUrl); });
  setActive(tabV, tabA); fillVideo(V, pageUrl);
}

function tabButton(text) {
  return el('button', { flex: '1', cursor: 'pointer', border: 'none', borderRadius: '6px',
    padding: '6px', font: '600 12px system-ui', background: '#333', color: '#ccc' }, text);
}
function setActive(on, off) { on.style.background = '#2b9ba3'; on.style.color = '#fff'; off.style.background = '#333'; off.style.color = '#ccc'; }

function fillVideo(V, pageUrl) {
  listEl.textContent = '';
  if (!V.length) { listEl.append(el('div', { padding: '10px', color: '#9aa' }, '영상 포맷 없음')); return; }
  for (const f of V) {
    const q = f.height ? `${f.height}p${f.fps && f.fps > 30 ? f.fps : ''}` : f.ext;
    const sub = [f.ext.toUpperCase(), fmtSize(f.size) + (f.size && f.approx ? '~' : ''), f.both ? '' : '+음성'].filter(Boolean).join(' · ');
    const format = f.both ? f.id : `${f.id}+bestaudio/${f.id}`; // 영상전용은 최고 음성을 합쳐 받는다(ffmpeg 필요)
    listEl.append(row(q, sub, () => send(pageUrl, 'video', format)));
  }
}
function fillAudio(A, pageUrl) {
  listEl.textContent = '';
  if (!A.length) { listEl.append(el('div', { padding: '10px', color: '#9aa' }, '오디오 포맷 없음')); return; }
  for (const f of A) {
    const q = f.abr ? `${Math.round(f.abr)}kbps` : f.ext;
    const sub = [f.ext.toUpperCase(), fmtSize(f.size) + (f.size && f.approx ? '~' : '')].filter(Boolean).join(' · ');
    listEl.append(row(q, sub, () => send(pageUrl, 'video', f.id)));
  }
}

async function fallbackList(pageUrl) {
  listEl.textContent = '';
  const s = activeVideo.currentSrc || activeVideo.src || '';
  const direct = /^https?:\/\//i.test(s);
  listEl.append(row(direct ? '이 영상 받기' : '이 페이지 영상 받기', direct ? '직접 링크' : 'yt-dlp',
    () => send(direct ? s : pageUrl, direct ? 'file' : 'video')));
  let streams = [];
  try { streams = await chrome.runtime.sendMessage({ type: 'getStreams' }); } catch {}
  for (const st of (streams || [])) {
    const isS = /\.(m3u8|mpd|m4s)(\?|$)/i.test(st.url);
    listEl.append(row(isS ? '스트림(HLS)' : '미디어', (st.url.split('/').pop() || '').slice(0, 30), () => send(st.url, isS ? 'video' : 'file')));
  }
}

/* 영상 감지 */
function attach(v) {
  if (seen.has(v)) return; seen.add(v);
  v.addEventListener('mouseenter', () => showButton(v));
  v.addEventListener('mouseleave', scheduleHide);
}
function scan() { document.querySelectorAll('video').forEach(attach); }
scan();
new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('scroll', () => { if (btn) btn.style.display = 'none'; if (panel) panel.style.display = 'none'; }, true);
