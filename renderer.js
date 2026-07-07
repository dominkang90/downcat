'use strict';
const $ = (id) => document.getElementById(id);
const tasksEl = $('tasks');
const cards = {}; // jobId -> {el, bar, status}

async function refreshOutDir() { $('outdir').textContent = await window.api.getOutDir(); }
refreshOutDir();

$('pick').onclick = async () => { await window.api.pickFolder(); refreshOutDir(); };
$('open').onclick = () => window.api.openFolder();

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
    c.bar.style.width = '100%'; c.bar.classList.add('indet');
    c.status.textContent = `받는 중… ${ev.files}개`;
  } else if (ev.type === 'error') {
    c.status.textContent = '오류: ' + ev.line;
  }
});

async function start() {
  const url = $('url').value.trim();
  if (!url) return;
  const mode = $('mode').value;
  const jobId = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  addCard(jobId, url, mode);
  $('url').value = '';
  const r = await window.api.download(jobId, url, mode);
  const c = cards[jobId];
  c.bar.classList.remove('indet');
  if (r.ok) { c.bar.style.width = '100%'; c.el.classList.add('ok'); c.status.textContent = '완료 ✓'; }
  else { c.el.classList.add('fail'); c.status.textContent = `실패 (code ${r.code ?? '?'})`; }
}

$('go').onclick = start;
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
