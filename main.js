'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, session, clipboard, Notification, net } = require('electron');
const fs = require('fs');
const path = require('path');

// ── 실행 기록(logs/main.log): 켜지다 꺼지는 등 문제가 생기면 이유를 파일로 남긴다 ──
const LOG_FILE = path.join(__dirname, 'logs', 'main.log');
function log(...parts) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch {}
    const line = parts.map(p => (p instanceof Error ? (p.stack || p.message) : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}
// 메인 프로세스 오류: 앱을 죽이지 않고 기록 + 한 번 알린다(예전엔 창이 그냥 사라질 수 있었음)
let errorShown = false;
function onFatal(kind, err) {
  log(kind, err);
  if (errorShown) return;
  errorShown = true;
  // showErrorBox는 창을 닫을 때까지 앱 전체를 멈추므로, 멈추지 않는 알림창을 쓴다(준비 전이면 준비된 뒤에)
  const show = () => dialog.showMessageBox({ type: 'error', title: '받냥이 오류',
    message: `${(err && err.message) || err}`, detail: `자세한 내용: ${LOG_FILE}` }).catch(() => {});
  if (app.isReady()) show(); else app.whenReady().then(show);
}
process.on('uncaughtException', (e) => onFatal('uncaughtException', e));
process.on('unhandledRejection', (e) => onFatal('unhandledRejection', e));
log('시작', { version: app.getVersion(), electron: process.versions.electron, os: `${process.platform} ${require('os').release()}`, dir: __dirname });

const engine = require('./engine');
const { createToolManager, toolsFor } = require('./tools');

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

// 도구 관리자: yt-dlp·gallery-dl·ffmpeg·aria2 자동 설치/업데이트(해시 확인 후). Windows에서만 켜진다.
// net.fetch = 크롬과 같은 네트워크(시스템 프록시 설정을 따름).
const BIN_DIR = path.join(__dirname, 'bin');
engine.setBinDir(BIN_DIR);
const tools = createToolManager({ binDir: BIN_DIR, fetch: (u, o) => net.fetch(u, o) });
const lastToolLog = {};
tools.on('change', (snap) => { // 설정 창·메인 창에 진행 상황 전달
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('tools-changed', snap);
  for (const t of snap) { // 도구마다 결과(설치됨/실패)가 바뀔 때만 기록
    if (t.status !== 'ok' && t.status !== 'error') continue;
    const s = t.status + (t.error ? ' ' + t.error : '') + (t.version ? ' ' + t.version : '');
    if (lastToolLog[t.name] !== s) { lastToolLog[t.name] = s; log('도구', t.label, s); }
  }
});

// 창·하위 프로세스가 비정상 종료되면 기록
app.on('render-process-gone', (_e, _wc, d) => log('화면 프로세스 종료', d));
app.on('child-process-gone', (_e, d) => log('하위 프로세스 종료', d));
app.on('will-quit', () => log('종료'));

// 이중 실행 방지: 두 번 켜면 새 창 대신 기존 창을 앞으로 (기록 파일 서로 덮어쓰기 방지)
if (!app.requestSingleInstanceLock()) {
  log('이미 켜진 받냥이가 있어 이번 실행은 닫음(작업 관리자에서 electron.exe 확인)');
  app.quit();
} else app.on('second-instance', () => {
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
  win.on('closed', () => log('메인 창 닫힘'));
  win.webContents.on('did-fail-load', (_e, code, desc) => log('화면 불러오기 실패', code, desc));
  win.webContents.on('console-message', (e) => { // 화면 쪽 오류도 기록 (Electron 35+는 이벤트 객체에 담겨 온다)
    if (e.level === 'error') log('화면 오류', `${e.message} (${path.basename(e.sourceId || '')}:${e.lineNumber})`);
  });
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
  tools.start().catch((e) => console.error('[tools]', e)); // 없는 도구 설치 + 하루 한 번 업데이트 확인
  // 로컬 브리지: 확장이 던진 URL을 clipboard-url과 같은 방식으로 창에 넣는다.
  bridgeServer = require('./bridge').createBridgeServer({
    token: settings.bridgeToken,
    onJob: (job) => {
      if (!mainWin || mainWin.isDestroyed()) return false; // 창 없으면 503
      mainWin.webContents.send('bridge-job', job);
      return true;
    },
    // 확장의 [연결하기]: 받냥이 창을 앞으로 띄우고 [예]를 누를 때만 토큰을 건넨다.
    onPair: ({ extensionId }) => askPair(extensionId),
    // 확장 패널이 요청한 영상 포맷 목록을 yt-dlp로 캐서 돌려준다(확장 쿠키가 있으면 임시로 굽는다).
    onProbe: async (job) => {
      await tools.whenReady(); // 도구 설치 중이면 끝날 때까지 기다린다
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

// 설치 파일에 들어 있는 공식 확장의 ID (manifest.json의 key로 계산 — 크롬과 같은 방식)
let OFFICIAL_EXT_ID = null;
try { OFFICIAL_EXT_ID = require('./bridge').extensionIdFromKey(require('./extension/manifest.json').key); } catch {}

// 확장 연결 요청 확인창. 브라우저를 보고 있던 사용자에게 받냥이 창을 앞으로 띄워 묻는다.
async function askPair(extensionId) {
  if (!mainWin || mainWin.isDestroyed()) return false;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show(); mainWin.focus(); mainWin.flashFrame(true);
  const official = extensionId === OFFICIAL_EXT_ID;
  const { response } = await dialog.showMessageBox(mainWin, {
    type: official ? 'question' : 'warning',
    title: '확장 연결',
    message: '브라우저 확장이 받냥이와 연결하려고 해요. 연결할까요?',
    detail: (official
      ? '받냥이 공식 확장이에요.'
      : '⚠ 받냥이 공식 확장과 ID가 달라요. 방금 직접 [연결하기]를 누른 게 아니라면 [아니요]를 누르세요.')
      + `\n확장 ID: ${extensionId}\n\n[예]를 누르면 이 확장이 받냥이로 다운로드를 보낼 수 있어요.`,
    buttons: ['예', '아니요'], defaultId: official ? 0 : 1, cancelId: 1, noLink: true,
  });
  mainWin.flashFrame(false);
  return response === 0;
}
// 앱을 닫으면 진행 중이던 다운로드 프로세스도 같이 끝낸다 (윈도우는 자식 프로세스가 저절로 안 죽음).
// ponytail: yt-dlp가 띄운 ffmpeg 손자 프로세스까지는 못 죽임 — 병합 몇 초짜리라 감수
app.on('before-quit', () => { for (const id in jobs) jobs[id].abort(); if (bridgeServer) bridgeServer.close(); tools.stop(); });

// 클립보드 감시: autoClip이 켜져 있으면 새 URL이 복사될 때 창에 알려 자동 추가.
let lastClip = '';
// Electron 44부터 clipboard.readText()가 약속(Promise)을 돌려준다 — 옛 버전(문자열)도 같이 받는다.
async function readClip() {
  try { return String((await clipboard.readText()) || '').trim(); } catch { return ''; }
}
async function startClipboardWatch() {
  lastClip = await readClip(); // 앱 켜기 전에 복사해둔 링크는 무시
  let busy = false;
  setInterval(async () => {
    if (busy || !settings.autoClip || !mainWin || mainWin.isDestroyed()) return;
    busy = true;
    try {
      const t = await readClip();
      if (t && t !== lastClip && /^https?:\/\/\S+$/.test(t)) {
        lastClip = t;
        if (!mainWin.isDestroyed()) mainWin.webContents.send('clipboard-url', t);
      }
    } finally { busy = false; }
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

// 도구 상태 / [지금 모두 확인·업데이트]
ipcMain.handle('tools-status', () => tools.snapshot());
ipcMain.handle('tools-update-all', () => tools.checkAll({ force: true }));

// 설정 창
let settingsWin = null;
ipcMain.handle('open-settings', () => {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 500, height: 760, title: '설정', parent: mainWin, resizable: true,
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
  // 이 작업이 쓸 도구를 설치하는 중이면, 설치가 끝날 때까지 기다렸다가 받는다(그동안 취소도 가능)
  const need = toolsFor(engine.pickTool(url, mode || 'auto'));
  if (!tools.isReady(need)) {
    send({ type: 'waiting', line: '도구 설치가 끝나면 시작해요' });
    await Promise.race([
      tools.whenReady(need),
      new Promise((res) => ac.signal.addEventListener('abort', res, { once: true })),
    ]);
  }
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
    error: result.error, needsLogin: !!result.needsLogin, at: new Date().toISOString() };
  const tasks = loadJson(TASKS, []);
  tasks.unshift(record);
  saveJson(TASKS, tasks.slice(0, 500));

  if (settings.notify && status !== 'canceled' && Notification.isSupported()) {
    new Notification({ title: status === 'done' ? '다운로드 완료' : '다운로드 끝(일부/실패)',
      body: url }).show();
  }
  return result;
});
