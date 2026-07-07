'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const engine = require('./engine');

const CONFIG = path.join(__dirname, 'config.json');
const TASKS = path.join(__dirname, 'tasks.json');

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
      win.webContents.executeJavaScript(
        `document.getElementById('url').value=${JSON.stringify(u)};document.getElementById('go').click();`
      );
      setTimeout(() => app.quit(), 30000); // 스모크: 배치 끝날 시간 준 뒤 종료
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
ipcMain.handle('download', async (e, { jobId, url, mode, cookieFile: cf }) => {
  const send = (ev) => e.sender.send('job-event', { jobId, ...ev });
  const result = await engine.download(url, { outDir, mode, cookieFile: cf }, send);
  // 완료된 작업 기록
  const tasks = loadJson(TASKS, []);
  tasks.unshift({ url, mode, tool: result.tool, ok: result.ok, at: new Date().toISOString() });
  saveJson(TASKS, tasks.slice(0, 500));
  return result;
});
