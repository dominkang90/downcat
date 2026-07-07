'use strict';
const $ = (id) => document.getElementById(id);

(async () => {
  const s = await window.api.getSettings();
  $('outdir').textContent = s.outDir;
  $('ytHeight').value = String(s.ytHeight || 0);
  $('stories').checked = !!s.stories;
  $('parallel').value = String(s.parallel || 2);
  $('autoClip').checked = !!s.autoClip;
  $('alwaysOnTop').checked = !!s.alwaysOnTop;
  $('notify').checked = !!s.notify;
})();

// 값 바뀌면 바로 저장
const save = (patch) => window.api.setSettings(patch);
$('ytHeight').onchange = () => save({ ytHeight: Number($('ytHeight').value) });
$('stories').onchange = () => save({ stories: $('stories').checked });
$('parallel').onchange = () => save({ parallel: Number($('parallel').value) });
$('autoClip').onchange = () => save({ autoClip: $('autoClip').checked });
$('alwaysOnTop').onchange = () => save({ alwaysOnTop: $('alwaysOnTop').checked });
$('notify').onchange = () => save({ notify: $('notify').checked });
$('pick').onclick = async () => { const d = await window.api.pickFolder(); $('outdir').textContent = d; };

// ffmpeg 상태/설치
async function refreshFf() {
  const has = await window.api.ffmpegStatus();
  $('ffstatus').textContent = has ? 'ffmpeg 설치됨 ✓ (고화질 병합 가능)' : '고화질(1080p+) 병합엔 ffmpeg 필요';
  $('ffinstall').style.display = has ? 'none' : '';
}
refreshFf();
$('ffinstall').onclick = async () => {
  $('ffinstall').disabled = true; $('ffinstall').textContent = '설치 중… (약 40MB)';
  const r = await window.api.installFfmpeg();
  $('ffinstall').disabled = false; $('ffinstall').textContent = 'ffmpeg 설치';
  if (r.ok) refreshFf(); else alert('설치 실패: ' + r.error);
};
