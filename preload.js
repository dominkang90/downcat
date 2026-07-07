'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  download: (jobId, url, mode, cookies) => ipcRenderer.invoke('download', { jobId, url, mode, cookies }),
  getOutDir: () => ipcRenderer.invoke('get-outdir'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  onJobEvent: (cb) => ipcRenderer.on('job-event', (_e, data) => cb(data)),
});
