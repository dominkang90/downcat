'use strict';
const $ = (id) => document.getElementById(id);
const tasksEl = $('tasks');

// ── 상태 ──
let taskList = [];      // {id,url,mode,status,count,bytes,thumb,tool}
const els = {};         // id -> {el, bar, statusEl, thumbEl, subEl, rightEl}

const LABELS = ['', '#e5484d', '#f2820c', '#f5c518', '#46a758', '#00b0c7', '#3b82f6', '#d6409f', '#9aa1ab'];
let activeLabel = null; // 하단 색점 필터(null=전체)
const fmtSize = (b) => !b ? '' : b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const siteOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const toFileUrl = (p) => encodeURI('file:///' + p.replace(/\\/g, '/')).replace(/#/g, '%23'); // #은 encodeURI가 안 바꿔서 직접
const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const STATUS_TEXT = { downloading: '받는 중…', queued: '대기 중', done: '완료 ✓', partial: '일부 받음 · 사이트가 막음', fail: '실패', canceled: '취소됨' };

// ── 설정 표시(쿠키) ──
async function refreshOutDir() { /* 하단 상태용 여지 */ }
async function refreshCookie() {
  const f = await window.api.getCookieFile();
  $('cookiename').textContent = f ? '쿠키: ' + f.split(/[\\/]/).pop() : '쿠키 없음';
}
refreshCookie();

$('opensettings').onclick = () => window.api.openSettings();
$('instalogin').onclick = async () => {
  // 입력칸에 URL이 있으면 그 사이트로, 없으면 인스타 로그인 페이지로 연다.
  const first = ($('url').value.trim().split(/\s+/)[0]) || '';
  let start = 'https://www.instagram.com/accounts/login/';
  try { if (first) start = new URL(first).origin + '/'; } catch {}
  $('instalogin').textContent = '로그인 창 열림…';
  const r = await window.api.openLogin(start); // 창을 닫으면 resolve
  $('instalogin').textContent = '🔑 로그인';
  if (r.ok) { $('usecookie').checked = true; await refreshCookie(); }
};

// ── 탭 ──
function showTab(which) {
  const dl = which === 'dl';
  $('dlview').hidden = !dl; $('galleryview').hidden = dl;
  $('tab-dl').classList.toggle('on', dl); $('tab-gallery').classList.toggle('on', !dl);
  if (!dl) renderGallery();
}
$('tab-dl').onclick = () => showTab('dl');
$('tab-gallery').onclick = () => showTab('gallery');
$('refresh').onclick = renderGallery;

// ── 갤러리 ──
async function renderGallery() {
  const items = await window.api.listGallery();
  $('gallery-count').textContent = `${items.length}개`;
  const grid = $('grid'); grid.innerHTML = '';
  for (const it of items) {
    const tile = document.createElement('div');
    tile.className = 'tile'; tile.title = it.name;
    tile.innerHTML = it.isVideo ? `<div class="vthumb">🎬</div><div class="cap"></div>`
      : `<img loading="lazy" src="${toFileUrl(it.path)}" /><div class="cap"></div>`;
    tile.querySelector('.cap').textContent = it.name;
    tile.onclick = () => window.api.showItem(it.path);
    grid.appendChild(tile);
  }
}

// ── 작업 카드 ──
function cardHtml(t) {
  // 옛 기록에 영상 경로가 thumb으로 들어간 경우가 있어 이미지 파일일 때만 <img>로
  const thumb = t.thumb && IMG_RE.test(t.thumb) ? `<img src="${toFileUrl(t.thumb)}" />` : '🎬';
  return `
    <div class="thumb">${thumb}</div>
    <div class="info">
      <div class="title"></div>
      <div class="sub">
        <span class="badge">${siteOf(t.url)}</span>
        <span class="statusText"></span>
        <span class="stat cnt"></span>
        <span class="stat sz"></span>
      </div>
    </div>
    <div class="right"></div>
    <span class="labeldot" title="색 라벨(클릭해서 바꾸기)"></span>
    <div class="track"><div class="bar"></div></div>`;
}
function fillCard(li, t) {
  li.className = 'task ' + t.status;
  li.querySelector('.title').textContent = t.url;
  li.querySelector('.statusText').textContent = STATUS_TEXT[t.status] || '';
  li.querySelector('.cnt').textContent = t.count ? `🖼 ${t.count}p` : '';
  li.querySelector('.sz').textContent = t.bytes ? `⬇ ${fmtSize(t.bytes)}` : '';
  const bar = li.querySelector('.bar');
  bar.classList.toggle('indet', t.status === 'downloading' && !t._pct);
  if (t.status === 'done') bar.style.width = '100%';
  else if (t.status !== 'downloading') bar.style.width = t.count ? '100%' : '0';
  // 오른쪽 버튼: 진행중=취소, 끝=폴더/다시받기
  const right = li.querySelector('.right'); right.innerHTML = '';
  if (t.status === 'downloading') {
    right.appendChild(mkBtn('✕', '취소', () => window.api.cancelJob(t.id)));
  } else if (t.status === 'queued') {
    right.appendChild(mkBtn('✕', '대기 취소', () => { t.status = 'canceled'; fillCard(li, t); }));
  } else {
    const f = t.file || t.thumb;
    if (f) right.appendChild(mkBtn('📂', '폴더 열기', () => window.api.showItem(f)));
    if (t.status !== 'done') right.appendChild(mkBtn('↻', '다시 받기', () => startOne(t)));
    right.appendChild(mkBtn('🗑', '기록 지우기 (받은 파일은 남음)', () => removeCard(t)));
  }
  // 색 라벨 점
  const ld = li.querySelector('.labeldot');
  ld.style.background = t.label || 'transparent';
  ld.style.boxShadow = t.label ? '0 0 0 1px rgba(0,0,0,.2)' : 'inset 0 0 0 1px #d5dade';
  ld.onclick = (ev) => {
    ev.stopPropagation();
    const i = LABELS.indexOf(t.label || '');
    t.label = LABELS[(i + 1) % LABELS.length];
    window.api.setTaskLabel(t.id, t.label);
    ld.style.background = t.label || 'transparent';
    ld.style.boxShadow = t.label ? '0 0 0 1px rgba(0,0,0,.2)' : 'inset 0 0 0 1px #d5dade';
    if (activeLabel != null) render();
  };
}

// 카드 하나를 목록·저장기록에서 제거 (받은 파일은 남음)
function removeCard(t) {
  taskList = taskList.filter(x => x.id !== t.id); delete els[t.id];
  window.api.removeTask(t.id); render();
}

// 하단 색점: 그 색 라벨만 보기(다시 누르면 해제)
function buildLabels() {
  const bar = $('labels'); bar.innerHTML = '';
  for (const c of LABELS.slice(1)) {
    const d = document.createElement('span');
    d.className = 'dot'; d.style.background = c; d.title = '이 색만 보기';
    if (activeLabel === c) d.style.outline = '2px solid #232830';
    d.onclick = () => { activeLabel = activeLabel === c ? null : c; buildLabels(); render(); };
    bar.appendChild(d);
  }
}
buildLabels();
function mkBtn(icon, title, onclick) {
  const b = document.createElement('button');
  b.className = 'act'; b.textContent = icon; b.title = title; b.onclick = onclick;
  return b;
}

// 정렬 + 검색 반영해 목록 전체 다시 그림
function render() {
  const q = $('filter').value.trim().toLowerCase();
  const sort = $('sort').value;
  let list = taskList.filter(t => (!q || t.url.toLowerCase().includes(q)) && (activeLabel == null || t.label === activeLabel));
  const rank = { downloading: 0, queued: 1, partial: 2, fail: 3, canceled: 4, done: 5 };
  list.sort((a, b) => sort === 'title' ? a.url.localeCompare(b.url)
    : sort === 'site' ? siteOf(a.url).localeCompare(siteOf(b.url))
    : sort === 'status' ? (rank[a.status] - rank[b.status])
    : (b._seq - a._seq)); // recent
  tasksEl.innerHTML = '';
  for (const t of list) {
    const li = document.createElement('li');
    li.innerHTML = cardHtml(t);
    fillCard(li, t);
    tasksEl.appendChild(li);
    els[t.id] = li;
  }
  $('count').textContent = `${taskList.length}개`;
}
$('sort').onchange = render;
$('filter').oninput = render;

// ── 다운로드 실행 ──
// 대기열: 동시에 parallel개(설정, 기본 2)만 받고 나머지는 '대기 중'으로 줄 세운다.
let seq = 1;
const queue = []; let running = 0;
async function pump() {
  const max = (await window.api.getSettings()).parallel || 2;
  while (running < max && queue.length) {
    const t = queue.shift();
    if (t.status !== 'queued') continue; // 대기 중에 취소된 작업은 건너뜀
    running++;
    runOne(t).finally(() => { running--; pump(); });
  }
}
function startOne(t) { // 새 작업·다시 받기 → 대기열에 넣는다
  t.status = 'queued'; t.count = 0; t.bytes = 0; t._pct = 0;
  if (els[t.id]) fillCard(els[t.id], t); else render();
  queue.push(t); pump();
}
async function runOne(t) {
  t.status = 'downloading';
  if (els[t.id]) fillCard(els[t.id], t);
  const thumbnail = $('thumb').checked;
  const useCookie = $('usecookie').checked;
  const r = await window.api.download(t.id, t.url, t.mode, useCookie, thumbnail);
  t.status = r.canceled ? 'canceled' : r.ok ? 'done' : (r.count > 0 ? 'partial' : 'fail');
  t.count = r.count; t.bytes = r.bytes; t.thumb = r.thumb; t.file = r.file;
  if (els[t.id]) fillCard(els[t.id], t);
  if (t.status === 'done' && (await window.api.getSettings()).autoRemove) removeCard(t); // 설정: 완료 자동 제거
}
function addTask(url, mode) {
  const t = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), url, mode, status: 'downloading', count: 0, bytes: 0, thumb: null, _seq: seq++ };
  taskList.unshift(t); render();
  startOne(t);
}
function start() {
  const urls = $('url').value.split(/\s+/).map(s => s.trim()).filter(Boolean);
  if (!urls.length) return;
  const mode = $('mode').value;
  $('url').value = '';
  for (const url of urls) addTask(url, mode);
}
$('go').onclick = start;
$('play').onclick = start;
$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); start(); }
});

// 진행률 이벤트(살아있는 작업 카드 갱신)
window.api.onJobEvent((ev) => {
  const li = els[ev.jobId]; const t = taskList.find(x => x.id === ev.jobId);
  if (!li || !t) return;
  if (ev.type === 'progress' && ev.percent != null) {
    t._pct = ev.percent; li.querySelector('.bar').classList.remove('indet');
    li.querySelector('.bar').style.width = ev.percent + '%';
    const extra = [ev.speed, ev.eta && '남은 ' + ev.eta].filter(Boolean).join(' · ');
    li.querySelector('.statusText').textContent = `받는 중 ${ev.percent}%` + (extra ? ' · ' + extra : '');
  } else if (ev.type === 'progress' && ev.files != null) {
    t.count = ev.files; li.querySelector('.cnt').textContent = `🖼 ${ev.files}p`;
    li.querySelector('.statusText').textContent = `받는 중… ${ev.files}개`;
  }
});

// 링크를 창에 끌어다 놓으면 바로 추가
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const txt = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  for (const u of (txt || '').split(/\s+/).filter(s => /^https?:\/\//.test(s))) addTask(u, $('mode').value);
});

// 클립보드에서 자동 추가
window.api.onClipboardUrl((url) => {
  if (taskList.some(t => t.url === url && t.status === 'downloading')) return;
  addTask(url, $('mode').value);
});

// 시작 시 저장된 작업 복원
(async () => {
  const saved = await window.api.getTasks();
  const seen = new Set();
  for (const r of saved) {
    if (seen.has(r.id)) continue; seen.add(r.id);
    taskList.push({ ...r, _seq: seq++ });
  }
  taskList.reverse(); // 최신이 위로
  render();
})();
