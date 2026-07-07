'use strict';
const $ = (id) => document.getElementById(id);
const tasksEl = $('tasks');
const cards = {}; // jobId -> {el, bar, status}

async function refreshOutDir() { $('outdir').textContent = await window.api.getOutDir(); }
async function refreshCookie() {
  const f = await window.api.getCookieFile();
  $('cookiename').textContent = f ? f.split(/[\\/]/).pop() : '없음';
}
refreshOutDir();
refreshCookie();

$('pick').onclick = async () => { await window.api.pickFolder(); refreshOutDir(); };
$('open').onclick = () => window.api.openFolder();

$('instalogin').onclick = async () => {
  $('instalogin').textContent = '로그인 창 열림…';
  const r = await window.api.instaLogin();
  $('instalogin').textContent = '🔑 인스타 로그인';
  if (r.ok) { $('usecookie').checked = true; await refreshCookie(); $('cookiename').textContent += ' ✓'; }
  else if (!r.canceled) alert('로그인은 됐는데 쿠키를 못 읽었어. 다시 시도해줘.');
};

// ── 탭 전환 ──
function showTab(which) {
  const dl = which === 'dl';
  $('dlview').hidden = !dl;
  $('galleryview').hidden = dl;
  $('tab-dl').classList.toggle('on', dl);
  $('tab-gallery').classList.toggle('on', !dl);
  if (!dl) renderGallery();
}
$('tab-dl').onclick = () => showTab('dl');
$('tab-gallery').onclick = () => showTab('gallery');
$('refresh').onclick = renderGallery;

// ── 갤러리 ──
function toFileUrl(p) { return encodeURI('file:///' + p.replace(/\\/g, '/')); }
async function renderGallery() {
  const items = await window.api.listGallery();
  $('gallery-count').textContent = `${items.length}개`;
  const grid = $('grid');
  grid.innerHTML = '';
  for (const it of items) {
    const tile = document.createElement('div');
    tile.className = 'tile' + (it.isVideo ? ' video' : '');
    tile.title = it.name;
    if (it.isVideo) tile.innerHTML = `<div class="vthumb">🎬</div><div class="cap"></div>`;
    else tile.innerHTML = `<img loading="lazy" src="${toFileUrl(it.path)}" /><div class="cap"></div>`;
    tile.querySelector('.cap').textContent = it.name;
    tile.onclick = () => window.api.showItem(it.path);
    grid.appendChild(tile);
  }
}

// ── 다운로드 ──
function addCard(jobId, url, mode) {
  const li = document.createElement('li');
  li.className = 'task';
  li.innerHTML = `
    <div class="task-top"><span class="url"></span><span class="badge">${mode}</span></div>
    <div class="track"><div class="bar"></div></div>
    <div class="status">준비 중…</div>`;
  li.querySelector('.url').textContent = url;
  tasksEl.prepend(li);
  cards[jobId] = { bar: li.querySelector('.bar'), status: li.querySelector('.status'), el: li };
}

window.api.onJobEvent((ev) => {
  const c = cards[ev.jobId];
  if (!c) return;
  if (ev.type === 'start') c.status.textContent = `${ev.tool} 시작…`;
  else if (ev.type === 'progress' && ev.percent != null) {
    c.bar.style.width = ev.percent + '%';
    c.status.textContent = `받는 중 ${ev.percent}%`;
  } else if (ev.type === 'progress' && ev.files != null) {
    c.filesGot = ev.files;
    c.bar.style.width = '100%'; c.bar.classList.add('indet');
    c.status.textContent = `받는 중… ${ev.files}개`;
  } else if (ev.type === 'error') {
    c.status.textContent = '오류: ' + ev.line;
  }
});

async function downloadOne(url, mode, cookieFile, thumbnail) {
  const jobId = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  addCard(jobId, url, mode);
  const r = await window.api.download(jobId, url, mode, cookieFile, thumbnail);
  const c = cards[jobId];
  c.bar.classList.remove('indet');
  if (r.ok) { c.bar.style.width = '100%'; c.el.classList.add('ok'); c.status.textContent = '완료 ✓'; }
  else if (c.filesGot) {
    // 일부 받고 막힘(인스타 차단 등) — 무섭게 실패로 안 보이게
    c.bar.style.width = '100%'; c.el.classList.add('partial');
    c.status.textContent = `일부 받음 (${c.filesGot}개) · 사이트가 중간에 막음`;
  } else { c.el.classList.add('fail'); c.status.textContent = `실패 (code ${r.code ?? '?'})`; }
}

async function start() {
  const urls = $('url').value.split(/\s+/).map(s => s.trim()).filter(Boolean);
  if (!urls.length) return;
  const mode = $('mode').value;
  const thumbnail = $('thumb').checked;
  const cookieFile = $('usecookie').checked ? await window.api.getCookieFile() : null;
  $('url').value = '';
  for (const url of urls) await downloadOne(url, mode, cookieFile, thumbnail);
}

$('go').onclick = start;
$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); start(); }
});
