'use strict';
// 예전 받냥이 폴더(ZIP·소스로 쓰던 판)의 설정·작업 기록·로그인 쿠키를 지금 데이터 폴더로 가져온다.
// 받아 둔 파일과 예전 폴더는 건드리지 않는다.
const fs = require('fs');
const path = require('path');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// cur = { settings, tasks, cookiesTxt, keys }. keys = 가져와도 되는 설정 이름(기본값에 있는 것).
function importOldData(oldDir, cur) {
  const oldCfg = readJson(path.join(oldDir, 'config.json'));
  const oldTasks = readJson(path.join(oldDir, 'tasks.json'));
  const oldCookie = path.join(oldDir, 'cookies', 'cookies.txt');
  const hasCfg = !!oldCfg && typeof oldCfg === 'object' && !Array.isArray(oldCfg);
  if (!hasCfg && !Array.isArray(oldTasks) && !fs.existsSync(oldCookie)) throw new Error('이 폴더에서 받냥이 설정이나 기록을 찾지 못했어요.');

  const settings = { ...cur.settings };
  // 아는 이름이고 형식이 같은 값만 받는다(손으로 고친 설정 파일이 앱을 깨지 않게).
  if (hasCfg) for (const k of cur.keys) {
    if (k in oldCfg && (cur.settings[k] == null ? (oldCfg[k] === null || typeof oldCfg[k] === 'string') : typeof oldCfg[k] === typeof cur.settings[k])) settings[k] = oldCfg[k];
  }
  let cookie = false;
  if (fs.existsSync(oldCookie) && !fs.existsSync(cur.cookiesTxt)) { // 지금 로그인 쿠키가 있으면 덮어쓰지 않는다
    fs.mkdirSync(path.dirname(cur.cookiesTxt), { recursive: true });
    fs.copyFileSync(oldCookie, cur.cookiesTxt, fs.constants.COPYFILE_EXCL);
    cookie = true;
  }
  // 예전 폴더 안의 쿠키 파일을 가리키던 설정은 새 위치로 돌린다.
  if (typeof settings.cookieFile === 'string' && path.resolve(settings.cookieFile) === path.resolve(oldCookie)) {
    settings.cookieFile = fs.existsSync(cur.cookiesTxt) ? cur.cookiesTxt : null;
  }
  let tasks = cur.tasks, taskCount = 0;
  if (Array.isArray(oldTasks)) {
    const have = new Set(tasks.map(t => t.id));
    const add = oldTasks.filter(t => t && typeof t === 'object' && t.id != null && !have.has(t.id));
    taskCount = add.length;
    tasks = [...tasks, ...add].sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 500);
  }
  return { settings, tasks, cookie, taskCount };
}
module.exports = { importOldData };
