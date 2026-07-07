'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  download: (jobId, url, mode, useCookie, thumbnail) => ipcRenderer.invoke('download', { jobId, url, mode, useCookie, thumbnail }),
  cancelJob: (jobId) => ipcRenderer.invoke('cancel-job', jobId),
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  getOutDir: () => ipcRenderer.invoke('get-outdir'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  pickCookieFile: () => ipcRenderer.invoke('pick-cookie-file'),
  getCookieFile: () => ipcRenderer.invoke('get-cookie-file'),
  instaLogin: () => ipcRenderer.invoke('insta-login'),
  listGallery: () => ipcRenderer.invoke('list-gallery'),
  showItem: (p) => ipcRenderer.invoke('open-path', p),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  onJobEvent: (cb) => ipcRenderer.on('job-event', (_e, data) => cb(data)),
  onClipboardUrl: (cb) => ipcRenderer.on('clipboard-url', (_e, url) => cb(url)),
});
