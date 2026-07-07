'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  download: (jobId, url, mode, cookieFile, thumbnail) => ipcRenderer.invoke('download', { jobId, url, mode, cookieFile, thumbnail }),
  getOutDir: () => ipcRenderer.invoke('get-outdir'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  pickCookieFile: () => ipcRenderer.invoke('pick-cookie-file'),
  getCookieFile: () => ipcRenderer.invoke('get-cookie-file'),
  instaLogin: () => ipcRenderer.invoke('insta-login'),
  listGallery: () => ipcRenderer.invoke('list-gallery'),
  showItem: (p) => ipcRenderer.invoke('open-path', p),
  onJobEvent: (cb) => ipcRenderer.on('job-event', (_e, data) => cb(data)),
});
