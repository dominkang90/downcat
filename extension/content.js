'use strict';
// 화면에 보이는 영상의 우측 상단에 "받냥이" 버튼을 항상 띄운다(유튜브는 hover를 자체 오버레이가
// 먹어서 고정 방식이 안정적). 누르면 받을 수 있는 포맷(영상/오디오 탭, 화질·용량·썸네일)을 보여준다.

const Z = 2147483647;
let btn, panel, head, tabsEl, listEl, activeVideo;

/* 유틸 */
function el(tag, style, text) { const e = document.createElement(tag); if (style) Object.assign(e.style, style); if (text != null) e.textContent = text; return e; }
function fmtSize(n) { if (!n) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0, v = n; while (v >= 1024 && i < 3) { v /= 1024; i++; } return (v < 10 ? v.toFixed(1) : Math.round(v)) + u[i]; }
function send(url, mode, format) { return chrome.runtime.sendMessage({ type: 'send', url, mode, format }).catch(() => ({ ok: false, error: '확장 오류' })); }

/* ---- 버튼: 화면에서 가장 크게 보이는 영상의 우측 상단에 고정 ---- */
function ensureButton() {
  if (btn) return;
  btn = el('button', { position: 'fixed', zIndex: String(Z), display: 'none', cursor: 'pointer',
    background: 'rgba(43,155,163,.95)', color: '#fff', border: 'none', borderRadius: '6px',
    padding: '5px 9px', font: '600 12px system-ui,sans-serif', boxShadow: '0 2px 8px rgba(0,0,0,.45)' }, '⬇ 받냥이');
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(); });
  document.documentElement.appendChild(btn);
}

// 화면에 가장 크게 보이는 <video>를 고른다(작은 광고·썸네일 제외).
function pickPrimary() {
  let best = null, area = 0;
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    if (r.width < 200 || r.height < 120) continue;
    const vis = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    if (vis > area) { area = vis; best = v; }
  }
  return area > 0 ? best : null;
}

function reposition() {
  ensureButton();
  const v = pickPrimary();
  if (!v) { btn.style.display = 'none'; if (panel) panel.style.display = 'none'; return; }
  activeVideo = v;
  const r = v.getBoundingClientRect();
  btn.style.left = Math.min(innerWidth - 96, r.right - 100) + 'px';   // 우측 상단
  btn.style.top = Math.max(6, r.top + 8) + 'px';
  btn.style.display = 'block';
  if (panel && panel.style.display === 'block') positionPanel();
}

/* ---- 포맷 패널 ---- */
function ensurePanel() {
  if (panel) return;
  panel = el('div', { position: 'fixed', zIndex: String(Z), display: 'none', width: '320px',
    background: 'rgba(20,20,22,.96)', color: '#fff', borderRadius: '10px',
    font: '13px system-ui,sans-serif', boxShadow: '0 6px 22px rgba(0,0,0,.55)' });
  head = el('div', { display: 'flex', gap: '8px', padding: '8px', alignItems: 'center' });
  tabsEl = el('div', { display: 'flex', gap: '6px', padding: '0 8px 6px' });
  listEl = el('div', { maxHeight: '230px', overflowY: 'auto', padding: '0 6px 8px' });
  panel.append(head, tabsEl, listEl);
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.documentElement.appendChild(panel);
}
function positionPanel() {
  const r = activeVideo.getBoundingClientRect();
  panel.style.left = Math.min(innerWidth - 332, Math.max(8, r.right - 320)) + 'px';
  panel.style.top = Math.max(8, r.top + 40) + 'px';
}

function togglePanel() {
  ensurePanel();
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
  openPanel();
}

async function openPanel() {
  positionPanel();
  head.textContent = ''; tabsEl.textContent = ''; listEl.textContent = '';
  head.append(el('div', { padding: '6px', color: '#9aa' }, '받을 수 있는 화질 불러오는 중…'));
  panel.style.display = 'block';
  const url = location.href;
  const res = await chrome.runtime.sendMessage({ type: 'probe', url }).catch(() => ({ ok: false, error: '확장 오류' }));
  if (panel.style.display === 'block') renderPanel(res, url);
}

function makeHeader(thumb, title) {
  head.textContent = '';
  const t = el('div', { width: '86px', height: '48px', flex: 'none', borderRadius: '5px', background: '#333',
    backgroundSize: 'cover', backgroundPosition: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px' });
  if (thumb) t.style.backgroundImage = `url("${thumb}")`; else t.textContent = '🎬';
  const ti = el('div', { fontWeight: '700', lineHeight: '1.25', maxHeight: '48px', overflow: 'hidden' }, title || '받냥이로 받기');
  head.append(t, ti);
}

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
  if (!res || !res.ok) {
    makeHeader((activeVideo && activeVideo.poster) || null, (res && res.error) || '포맷을 못 읽었어요');
    fallbackList(pageUrl);
    return;
  }
  makeHeader(res.thumbnail || (activeVideo && activeVideo.poster), res.title);
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
    const format = f.both ? f.id : `${f.id}+bestaudio/${f.id}`; // 영상전용은 최고 음성 합쳐 받음(ffmpeg 필요)
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
  const s = (activeVideo && (activeVideo.currentSrc || activeVideo.src)) || '';
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

/* 패널 밖 클릭하면 닫기 */
document.addEventListener('click', (e) => {
  if (!panel || panel.style.display !== 'block') return;
  if (e.target === btn || panel.contains(e.target)) return;
  panel.style.display = 'none';
}, true);

/* 버튼을 영상 따라 계속 재배치 */
reposition();
setInterval(reposition, 800);
window.addEventListener('scroll', reposition, true);
window.addEventListener('resize', reposition);
