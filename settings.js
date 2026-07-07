'use strict';
const $ = (id) => document.getElementById(id);

(async () => {
  const s = await window.api.getSettings();
  $('outdir').textContent = s.outDir;
  $('ytHeight').value = String(s.ytHeight || 0);
  $('stories').checked = !!s.stories;
  $('autoClip').checked = !!s.autoClip;
  $('alwaysOnTop').checked = !!s.alwaysOnTop;
  $('notify').checked = !!s.notify;
})();

// 값 바뀌면 바로 저장
const save = (patch) => window.api.setSettings(patch);
$('ytHeight').onchange = () => save({ ytHeight: Number($('ytHeight').value) });
$('stories').onchange = () => save({ stories: $('stories').checked });
$('autoClip').onchange = () => save({ autoClip: $('autoClip').checked });
$('alwaysOnTop').onchange = () => save({ alwaysOnTop: $('alwaysOnTop').checked });
$('notify').onchange = () => save({ notify: $('notify').checked });
$('pick').onclick = async () => { const d = await window.api.pickFolder(); $('outdir').textContent = d; };
