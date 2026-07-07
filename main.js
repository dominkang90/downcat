'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const fs = require('fs');
const path = require('path');
const engine = require('./engine');

const CONFIG = path.join(__dirname, 'config.json');
const TASKS = path.join(__dirname, 'tasks.json');
const INSTA_COOKIES = path.join(__dirname, 'cookies', 'instagram.txt');

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function saveCfg() { saveJson(CONFIG, { outDir, cookieFile }); }

const cfg = loadJson(CONFIG, {});
let outDir = cfg.outDir || path.join(__dirname, 'downloads');
let cookieFile = cfg.cookieFile || null;

function createWindow() {
  const win = new BrowserWindow({
    width: 760, height: 620, minWidth: 560, minHeight: 420,
    title: '받냥이 - 다운로드',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
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
        : `document.getElementById('url').value=${JSON.stringify(u)};document.getElementById('go').click();`;
      win.webContents.executeJavaScript(js);
      setTimeout(() => app.quit(), 30000); // 스모크: 시간 준 뒤 종료
    });
  }
  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('get-outdir', () => outDir);

ipcMain.handle('pick-folder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (!r.canceled && r.filePaths[0]) { outDir = r.filePaths[0]; saveCfg(); }
  return outDir;
});

ipcMain.handle('open-folder', () => shell.openPath(outDir));
ipcMain.handle('open-path', (e, p) => shell.showItemInFolder(p));

// 갤러리: 저장폴더 안 이미지/영상을 최신순으로 모아 준다.
const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const VID_EXT = /\.(mp4|webm|mkv|mov|avi|m4v)$/i;
function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (IMG_EXT.test(ent.name) || VID_EXT.test(ent.name)) {
      let mtime = 0; try { mtime = fs.statSync(full).mtimeMs; } catch {}
      out.push({ path: full, name: ent.name, isVideo: VID_EXT.test(ent.name), mtime });
    }
  }
}
ipcMain.handle('list-gallery', () => {
  const out = [];
  walk(outDir, out);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 500); // ponytail: 최근 500개면 충분, 넘으면 페이지네이션
});

// 인스타 로그인: 앱 안 브라우저 창을 띄우고, 로그인되면(=sessionid 쿠키 생기면)
// 그 쿠키를 Netscape cookies.txt로 뽑아 저장·적용한다. (크롬 ABE 안 거침)
function netscapeLine(c) {
  const inclSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const exp = Math.floor(c.expirationDate || (Date.now() / 1000 + 31536000));
  return [c.domain, inclSub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t');
}
async function exportInstaCookies(ses) {
  const cookies = (await ses.cookies.get({})).filter(c => c.domain.includes('instagram.com'));
  fs.mkdirSync(path.dirname(INSTA_COOKIES), { recursive: true });
  fs.writeFileSync(INSTA_COOKIES, ['# Netscape HTTP Cookie File', ...cookies.map(netscapeLine)].join('\n') + '\n');
  return cookies.some(c => c.name === 'sessionid');
}

ipcMain.handle('insta-login', (e) => {
  const ses = session.fromPartition('persist:insta');
  const win = new BrowserWindow({
    width: 480, height: 760, title: '인스타그램 로그인',
    parent: BrowserWindow.fromWebContents(e.sender), modal: false,
    webPreferences: { partition: 'persist:insta' },
  });
  win.loadURL('https://www.instagram.com/accounts/login/');
  return new Promise((resolve) => {
    let done = false;
    const timer = setInterval(async () => {
      if (done || win.isDestroyed()) return;
      const cs = await ses.cookies.get({ name: 'sessionid' });
      if (cs.some(c => c.domain.includes('instagram.com'))) {
        done = true; clearInterval(timer);
        const ok = await exportInstaCookies(ses);
        cookieFile = INSTA_COOKIES; saveCfg();
        if (!win.isDestroyed()) win.close();
        resolve({ ok, file: INSTA_COOKIES });
      }
    }, 1500);
    win.on('closed', () => { if (!done) { done = true; clearInterval(timer); resolve({ ok: false, canceled: true }); } });
  });
});

ipcMain.handle('get-cookie-file', () => cookieFile);
ipcMain.handle('pick-cookie-file', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'cookies.txt', extensions: ['txt'] }],
  });
  if (!r.canceled && r.filePaths[0]) { cookieFile = r.filePaths[0]; saveCfg(); }
  return cookieFile;
});

// 다운로드: 진행 상황은 'job-event' 채널로 흘려보내고, 최종 결과만 반환한다.
ipcMain.handle('download', async (e, { jobId, url, mode, cookieFile: cf, thumbnail }) => {
  const send = (ev) => e.sender.send('job-event', { jobId, ...ev });
  const result = await engine.download(url, { outDir, mode, cookieFile: cf, thumbnail }, send);
  // 완료된 작업 기록
  const tasks = loadJson(TASKS, []);
  tasks.unshift({ url, mode, tool: result.tool, ok: result.ok, at: new Date().toISOString() });
  saveJson(TASKS, tasks.slice(0, 500));
  return result;
});
