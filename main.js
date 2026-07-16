'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, session, clipboard, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const engine = require('./engine');

const CONFIG = path.join(__dirname, 'config.json');
const TASKS = path.join(__dirname, 'tasks.json');
const COOKIES_TXT = path.join(__dirname, 'cookies', 'cookies.txt');

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) { // 임시파일에 쓰고 바꿔치기 — 쓰다 죽어도 원본이 안 깨짐
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// 설정 한 덩어리로 관리(기본값 + 저장된 값 병합).
const DEFAULTS = {
  outDir: path.join(__dirname, 'downloads'),
  cookieFile: null,
  ytHeight: 0,        // 0=최고화질, 1080/2160/4320
  stories: false,     // 인스타 스토리 포함
  autoClip: false,    // 클립보드에서 자동 추가
  parallel: 1,        // 안전한 기본값. 설정에서 늘릴 수 있음
  rateLimit: '',      // 최대 다운로드 속도 (''=무제한, '5M' 등)
  autoRemove: false,  // 완료된 작업 카드 자동 제거
  alwaysOnTop: false,
  notify: true,       // 작업 완료 알림
};
let settings = Object.assign({}, DEFAULTS, loadJson(CONFIG, {}));
// 브리지 토큰: 설치별 비밀. 첫 실행 때 만들어 config.json에 저장(gitignore됨). 확장 옵션에 붙여넣어 짝을 맞춘다.
if (!settings.bridgeToken) { settings.bridgeToken = require('crypto').randomBytes(24).toString('hex'); saveCfg(); }
let bridgeServer = null;
function saveCfg() { saveJson(CONFIG, settings); }
let mainWin = null;
const jobs = {}; // jobId -> AbortController (실행 중인 다운로드, 취소용)

// 이중 실행 방지: 두 번 켜면 새 창 대신 기존 창을 앞으로 (기록 파일 서로 덮어쓰기 방지)
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => {
  if (mainWin && !mainWin.isDestroyed()) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 820, height: 680, minWidth: 600, minHeight: 460,
    title: '받냥이 - 다운로드',
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWin = win;
  win.loadFile('index.html');
  // 스모크 테스트: DOWNCAT_SMOKE=<url> 이면 창→엔진 경로를 실제 버튼 클릭으로 검증한다.
  if (process.env.DOWNCAT_SMOKE) {
    win.webContents.on('did-finish-load', () => {
      const u = process.env.DOWNCAT_SMOKE;
      const js = u === '__gallery__'
        ? `document.getElementById('tab-gallery').click();`
        : u === '__login__'
        ? `document.getElementById('instalogin').click();`
        : u === '__settings__'
        ? `document.getElementById('opensettings').click();`
        : `document.getElementById('url').value=${JSON.stringify(u)};document.getElementById('go').click();`;
      win.webContents.executeJavaScript(js);
      setTimeout(() => app.quit(), 30000); // 스모크: 시간 준 뒤 종료
    });
  }
  return win;
}

app.whenReady().then(() => {
  createWindow();
  startClipboardWatch();
  // 로컬 브리지: 확장이 던진 URL을 clipboard-url과 같은 방식으로 창에 넣는다.
  bridgeServer = require('./bridge').createBridgeServer({
    token: settings.bridgeToken,
    onJob: (job) => {
      if (!mainWin || mainWin.isDestroyed()) return false; // 창 없으면 503
      mainWin.webContents.send('bridge-job', job);
      return true;
    },
    // 확장 패널이 요청한 영상 포맷 목록을 yt-dlp로 캐서 돌려준다(확장 쿠키가 있으면 임시로 굽는다).
    onProbe: async (job) => {
      let ck = null;
      if (job.cookies && job.cookies.length) {
        try {
          ck = path.join(app.getPath('temp'), `downcat-pk-${Date.now()}.txt`);
          fs.writeFileSync(ck, ['# Netscape HTTP Cookie File', ...job.cookies.map(netscapeLine)].join('\n') + '\n');
        } catch { ck = null; }
      }
      try {
        return await engine.probeFormats(job.url, { referer: job.referer, userAgent: job.userAgent, cookieFile: ck });
      } finally {
        if (ck) { try { fs.rmSync(ck, { force: true }); } catch {} }
      }
    },
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// 앱을 닫으면 진행 중이던 다운로드 프로세스도 같이 끝낸다 (윈도우는 자식 프로세스가 저절로 안 죽음).
// ponytail: yt-dlp가 띄운 ffmpeg 손자 프로세스까지는 못 죽임 — 병합 몇 초짜리라 감수
app.on('before-quit', () => { for (const id in jobs) jobs[id].abort(); if (bridgeServer) bridgeServer.close(); });

// 클립보드 감시: autoClip이 켜져 있으면 새 URL이 복사될 때 창에 알려 자동 추가.
let lastClip = '';
function startClipboardWatch() {
  lastClip = (clipboard.readText() || '').trim(); // 앱 켜기 전에 복사해둔 링크는 무시
  setInterval(() => {
    if (!settings.autoClip || !mainWin || mainWin.isDestroyed()) return;
    const t = (clipboard.readText() || '').trim();
    if (t && t !== lastClip && /^https?:\/\/\S+$/.test(t)) {
      lastClip = t;
      mainWin.webContents.send('clipboard-url', t);
    }
  }, 1000);
}

ipcMain.handle('get-outdir', () => settings.outDir);

ipcMain.handle('pick-folder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (!r.canceled && r.filePaths[0]) { settings.outDir = r.filePaths[0]; saveCfg(); }
  return settings.outDir;
});

ipcMain.handle('open-folder', () => shell.openPath(settings.outDir));

// 설정 읽기/쓰기 (설정 창에서 사용)
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('set-settings', (e, patch) => {
  Object.assign(settings, patch);
  saveCfg();
  if (mainWin && !mainWin.isDestroyed()) mainWin.setAlwaysOnTop(!!settings.alwaysOnTop);
  return settings;
});

// 작업 취소
ipcMain.handle('cancel-job', (e, jobId) => {
  if (jobs[jobId]) { jobs[jobId].abort(); return true; }
  return false;
});

// 저장된 작업 목록(복원용)
ipcMain.handle('get-tasks', () => loadJson(TASKS, []));

// 작업 기록 삭제 (카드의 🗑 버튼)
ipcMain.handle('remove-task', (e, id) => {
  saveJson(TASKS, loadJson(TASKS, []).filter(t => t.id !== id));
});

// 작업에 색 라벨 저장
ipcMain.handle('set-task-label', (e, id, label) => {
  const tasks = loadJson(TASKS, []);
  const t = tasks.find(x => x.id === id);
  if (t) { t.label = label; saveJson(TASKS, tasks); }
});

// ffmpeg (유튜브 고화질 병합용) 상태 확인 / 설치
const FFMPEG = path.join(__dirname, 'bin', 'ffmpeg.exe');
ipcMain.handle('ffmpeg-status', () => fs.existsSync(FFMPEG));
ipcMain.handle('install-ffmpeg', async () => {
  const { execFile } = require('child_process');
  const url = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';
  const tmpDir = path.join(app.getPath('temp'), 'downcat-ffmpeg');
  const zip = tmpDir + '.zip';
  try {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    const ps = `$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '${url}' -OutFile '${zip}'; Expand-Archive -Path '${zip}' -DestinationPath '${tmpDir}' -Force`;
    await new Promise((res, rej) => execFile('powershell', ['-NoProfile', '-Command', ps], { maxBuffer: 1 << 28 }, (e) => e ? rej(e) : res()));
    let found = null;
    (function walkFor(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walkFor(f);
        else if (!found && e.name.toLowerCase() === 'ffmpeg.exe') found = f;
      }
    })(tmpDir);
    if (!found) throw new Error('압축 안에서 ffmpeg.exe를 못 찾음');
    fs.mkdirSync(path.dirname(FFMPEG), { recursive: true });
    fs.copyFileSync(found, FFMPEG);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); fs.rmSync(zip, { force: true }); } catch {}
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// aria2c (일반 파일 가속 다운로드용) 상태 확인 / 자동 설치 — ffmpeg 패턴과 동일
const ARIA2C = path.join(__dirname, 'bin', 'aria2c.exe');
ipcMain.handle('aria2-status', () => fs.existsSync(ARIA2C));
ipcMain.handle('install-aria2', async () => {
  const { execFile } = require('child_process');
  const url = 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip';
  const tmpDir = path.join(app.getPath('temp'), 'downcat-aria2');
  const zip = tmpDir + '.zip';
  try {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    const ps = `$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '${url}' -OutFile '${zip}'; Expand-Archive -Path '${zip}' -DestinationPath '${tmpDir}' -Force`;
    await new Promise((res, rej) => execFile('powershell', ['-NoProfile', '-Command', ps], { maxBuffer: 1 << 28 }, (e) => e ? rej(e) : res()));
    let found = null;
    (function walkFor(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walkFor(f);
        else if (!found && e.name.toLowerCase() === 'aria2c.exe') found = f;
      }
    })(tmpDir);
    if (!found) throw new Error('압축 안에서 aria2c.exe를 못 찾음');
    fs.mkdirSync(path.dirname(ARIA2C), { recursive: true });
    fs.copyFileSync(found, ARIA2C);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); fs.rmSync(zip, { force: true }); } catch {}
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// 설정 창
let settingsWin = null;
ipcMain.handle('open-settings', () => {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 480, height: 600, title: '설정', parent: mainWin, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile('settings.html');
});
ipcMain.handle('open-path', (e, p) => shell.showItemInFolder(p));

// 갤러리: 저장폴더 안 이미지/영상을 최신순으로 모아 준다.
const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const VID_EXT = /\.(mp4|webm|mkv|mov|avi|m4v)$/i;
function walk(dir, out, budget) {
  if (--budget.n < 0) return; // ponytail: 스캔 상한 — 거대 폴더를 저장폴더로 지정해도 UI가 안 멈추게. 넘치면 일부만 보임
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (--budget.n < 0) return;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out, budget);
    else if (IMG_EXT.test(ent.name) || VID_EXT.test(ent.name)) {
      let mtime = 0; try { mtime = fs.statSync(full).birthtimeMs; } catch {} // 로컬 생성시각(최신 다운로드순)
      out.push({ path: full, name: ent.name, isVideo: VID_EXT.test(ent.name), mtime });
    }
  }
}
ipcMain.handle('list-gallery', () => {
  const out = [];
  walk(settings.outDir, out, { n: 20000 });
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 500); // ponytail: 최근 500개면 충분, 넘으면 페이지네이션
});

// 범용 로그인: 앱 안 브라우저 창에서 아무 사이트나 로그인하고 창을 닫으면,
// 그 세션의 쿠키 전체를 Netscape cookies.txt로 저장·적용한다. (크롬 ABE 안 거침)
function netscapeLine(c) {
  const inclSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const exp = Math.floor(c.expirationDate || (Date.now() / 1000 + 31536000));
  return [c.domain, inclSub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t');
}
async function exportAllCookies(ses) {
  const cookies = (await ses.cookies.get({})).filter(c => c.value);
  fs.mkdirSync(path.dirname(COOKIES_TXT), { recursive: true });
  fs.writeFileSync(COOKIES_TXT, ['# Netscape HTTP Cookie File', ...cookies.map(netscapeLine)].join('\n') + '\n');
  return cookies.length;
}

ipcMain.handle('open-login', async (e, startUrl) => {
  const ses = session.fromPartition('persist:downcat');
  // 로그인 없이 그냥 닫으면 아무것도 안 바꾸도록, 열기 전 쿠키 지문을 기억해 비교한다
  const fingerprint = async () => JSON.stringify((await ses.cookies.get({})).map(c => [c.domain, c.name, c.value]).sort());
  const before = await fingerprint();
  const win = new BrowserWindow({
    width: 520, height: 760, title: '로그인 (로그인 후 이 창을 닫으세요)',
    parent: mainWin, webPreferences: { partition: 'persist:downcat' },
  });
  win.loadURL(startUrl || 'https://www.instagram.com/accounts/login/');
  return new Promise((resolve) => {
    win.on('closed', async () => {
      if (await fingerprint() === before) { resolve({ ok: false, unchanged: true }); return; } // 쿠키 변화 전혀 없음(즉시 닫음) → 아무것도 안 함
      const n = await exportAllCookies(ses);
      // 사용자가 직접 고른 외부 cookies.txt를 쓰는 중이면 말없이 교체하지 않는다 (renderer가 물어봄)
      const external = !!settings.cookieFile && settings.cookieFile !== COOKIES_TXT;
      if (!external) { settings.cookieFile = COOKIES_TXT; saveCfg(); }
      resolve({ ok: n > 0, count: n, file: COOKIES_TXT, external });
    });
  });
});

ipcMain.handle('get-cookie-file', () => settings.cookieFile);
ipcMain.handle('pick-cookie-file', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'cookies.txt', extensions: ['txt'] }],
  });
  if (!r.canceled && r.filePaths[0]) { settings.cookieFile = r.filePaths[0]; saveCfg(); }
  return settings.cookieFile;
});

// 목록 페이지 → 영상 URL 배열 (야스 계열). 목록이 아니면 빈 배열.
ipcMain.handle('expand-listing', (e, url) => engine.expandListing(url));

// 다운로드: 진행 상황은 'job-event' 채널로, 최종 결과만 반환. jobId로 취소 가능.
ipcMain.handle('download', async (e, { jobId, url, mode, useCookie, thumbnail, extra }) => {
  const send = (ev) => { if (!e.sender.isDestroyed()) e.sender.send('job-event', { jobId, ...ev }); }; // 종료 중 창 사라짐 방어
  const ac = new AbortController();
  jobs[jobId] = ac;
  // 확장이 보낸 브라우저 쿠키가 있으면 이 작업만 쓸 임시 cookies.txt로 굽는다. 민감하므로 끝나면 지운다.
  let jobCookieFile = null;
  if (extra && Array.isArray(extra.cookies) && extra.cookies.length) {
    try {
      jobCookieFile = path.join(app.getPath('temp'), `downcat-ck-${jobId}.txt`);
      fs.writeFileSync(jobCookieFile, ['# Netscape HTTP Cookie File', ...extra.cookies.map(netscapeLine)].join('\n') + '\n');
    } catch { jobCookieFile = null; }
  }
  let result;
  try {
    result = await engine.download(url, {
      outDir: settings.outDir, mode,
      cookieFile: jobCookieFile || (useCookie ? settings.cookieFile : null), // 확장 쿠키 우선, 없으면 앱 로그인 쿠키
      referer: extra && extra.referer,   // 브리지(확장)가 준 referer — 엔진이 이미 지원
      userAgent: extra && extra.userAgent, // 확장이 준 브라우저 UA
      format: extra && extra.format,     // 확장 패널에서 고른 특정 화질(yt-dlp -f)
      thumbnail, ytHeight: settings.ytHeight, stories: settings.stories, rateLimit: settings.rateLimit,
      signal: ac.signal,
    }, send);
  } catch (err) { // 저장폴더 소실(USB 뽑힘 등) — 카드가 '받는 중'에 영원히 멈추지 않게 실패로 처리
    result = { ok: false, tool: null, code: -1, count: 0, bytes: 0, thumb: null, file: null, error: String(err) };
  } finally {
    if (jobCookieFile) { try { fs.rmSync(jobCookieFile, { force: true }); } catch {} } // 민감한 쿠키 파일 즉시 삭제
  }
  delete jobs[jobId];

  const status = result.canceled ? 'canceled' : result.ok ? 'done' : (result.count > 0 ? 'partial' : 'fail');
  const record = { id: jobId, url, mode, tool: result.tool, status,
    count: result.count, bytes: result.bytes, thumb: result.thumb, file: result.file,
    error: result.error, at: new Date().toISOString() };
  const tasks = loadJson(TASKS, []);
  tasks.unshift(record);
  saveJson(TASKS, tasks.slice(0, 500));

  if (settings.notify && status !== 'canceled' && Notification.isSupported()) {
    new Notification({ title: status === 'done' ? '다운로드 완료' : '다운로드 끝(일부/실패)',
      body: url }).show();
  }
  return result;
});
