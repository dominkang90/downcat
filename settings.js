'use strict';
const $ = (id) => document.getElementById(id);

(async () => {
  const s = await window.api.getSettings();
  $('outdir').textContent = s.outDir;
  $('ytHeight').value = String(s.ytHeight || 0);
  $('stories').checked = !!s.stories;
  $('parallel').value = String(s.parallel || 1);
  $('rateLimit').value = s.rateLimit || '';
  $('autoRemove').checked = !!s.autoRemove;
  $('autoClip').checked = !!s.autoClip;
  $('alwaysOnTop').checked = !!s.alwaysOnTop;
  $('notify').checked = !!s.notify;
})();

// 값 바뀌면 바로 저장
const save = (patch) => window.api.setSettings(patch);
$('ytHeight').onchange = () => save({ ytHeight: Number($('ytHeight').value) });
$('stories').onchange = () => save({ stories: $('stories').checked });
$('parallel').onchange = () => save({ parallel: Number($('parallel').value) });
$('rateLimit').onchange = () => save({ rateLimit: $('rateLimit').value });
$('autoRemove').onchange = () => save({ autoRemove: $('autoRemove').checked });
$('autoClip').onchange = () => save({ autoClip: $('autoClip').checked });
$('alwaysOnTop').onchange = () => save({ alwaysOnTop: $('alwaysOnTop').checked });
$('notify').onchange = () => save({ notify: $('notify').checked });
$('pick').onclick = async () => { const d = await window.api.pickFolder(); $('outdir').textContent = d; };

// 다운로드 도구 상태 / [지금 모두 확인·업데이트]
const TOOL_STATUS = {
  ok: ['설치됨 ✓', 'st-ok'], missing: ['없음', 'st-bad'], checking: ['확인 중…', 'st-busy'],
  downloading: ['받는 중', 'st-busy'], verifying: ['해시 확인 중…', 'st-busy'], installing: ['설치 중…', 'st-busy'],
  error: ['설치 실패', 'st-bad'], manual: ['직접 설치(Windows 아님)', ''],
};
function renderTools(list) {
  const t = $('tools'); t.innerHTML = '';
  for (const it of list) {
    const tr = document.createElement('tr');
    const [txt, cls] = TOOL_STATUS[it.status] || [it.status, ''];
    const ver = it.version || '-';
    tr.innerHTML = '<td class="name"></td><td class="ver"></td><td class="st"></td>';
    tr.querySelector('.name').textContent = it.label;
    tr.querySelector('.ver').textContent = ver;
    const st = tr.querySelector('.st');
    st.textContent = txt + (it.status === 'downloading' && it.percent != null ? ` ${it.percent}%` : '');
    st.className = 'st ' + cls;
    if (it.error) st.title = it.error;
    t.appendChild(tr);
  }
  const errs = list.filter(x => x.error);
  $('toolsnote').textContent = errs.length ? '⚠ ' + errs.map(x => x.error).join(' / ') : '';
  $('toolsnote').title = $('toolsnote').textContent;
}
window.api.toolsStatus().then(renderTools);
window.api.onToolsChanged(renderTools);
$('toolsupdate').onclick = async () => {
  const b = $('toolsupdate');
  b.disabled = true; b.textContent = '확인 중…';
  try {
    const r = await window.api.updateTools();
    const changed = r.filter(x => x.result === 'installed' || x.result === 'updated').map(x => x.name);
    const failed = r.filter(x => x.result === 'error');
    b.textContent = failed.length ? '일부 실패 — 다시 시도' : changed.length ? `업데이트 ${changed.length}개 완료 ✓` : '모두 최신 ✓';
  } catch (e) {
    b.textContent = '확인 실패 — 다시 시도';
  } finally {
    b.disabled = false;
    setTimeout(() => { b.textContent = '지금 모두 확인·업데이트'; }, 4000);
  }
};

// 브라우저 확장 설치 도우미(받냥이-확장설치.bat) 실행
$('extinstall').onclick = () => window.api.openExtInstaller();
