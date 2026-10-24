// 최소 Electron 앱: 받냥이 코드 없이 창 하나만 띄워 본다(엔진 자체 문제인지 가리기용)
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const path = require('path');
const out = path.join(__dirname, '..', '..', 'logs', 'diag-min-steps.txt');
const step = (s) => fs.appendFileSync(out, `[${new Date().toISOString()}] ${s}\n`);
step('js start ' + process.versions.electron + ' args=' + process.argv.slice(1).join(' '));
app.on('child-process-gone', (_e, d) => step('child gone ' + JSON.stringify(d)));
app.on('render-process-gone', (_e, _w, d) => step('render gone ' + JSON.stringify(d)));
app.whenReady().then(() => {
  step('ready; gpu=' + JSON.stringify(app.getGPUFeatureStatus()));
  const w = new BrowserWindow({ width: 300, height: 200, show: true });
  w.loadURL('data:text/html,<h1>diag ok</h1>');
  w.webContents.on('did-finish-load', () => { step('loaded'); setTimeout(() => app.quit(), 1500); });
});
