'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  download: (jobId, url, mode, cookieFile) => ipcRenderer.invoke('download', { jobId, url, mode, cookieFile }),
  getOutDir: () => ipcRenderer.invoke('get-outdir'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  pickCookieFile: () => ipcRenderer.invoke('pick-cookie-file'),
  getCookieFile: () => ipcRenderer.invoke('get-cookie-file'),
  onJobEvent: (cb) => ipcRenderer.on('job-event', (_e, data) => cb(data)),
});
