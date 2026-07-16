'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  download: (jobId, url, mode, useCookie, thumbnail, extra) => ipcRenderer.invoke('download', { jobId, url, mode, useCookie, thumbnail, extra }),
  expandListing: (url) => ipcRenderer.invoke('expand-listing', url),
  cancelJob: (jobId) => ipcRenderer.invoke('cancel-job', jobId),
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  setTaskLabel: (id, label) => ipcRenderer.invoke('set-task-label', id, label),
  removeTask: (id) => ipcRenderer.invoke('remove-task', id),
  getOutDir: () => ipcRenderer.invoke('get-outdir'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  pickCookieFile: () => ipcRenderer.invoke('pick-cookie-file'),
  getCookieFile: () => ipcRenderer.invoke('get-cookie-file'),
  openLogin: (startUrl) => ipcRenderer.invoke('open-login', startUrl),
  listGallery: () => ipcRenderer.invoke('list-gallery'),
  showItem: (p) => ipcRenderer.invoke('open-path', p),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  ffmpegStatus: () => ipcRenderer.invoke('ffmpeg-status'),
  installFfmpeg: () => ipcRenderer.invoke('install-ffmpeg'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  onJobEvent: (cb) => ipcRenderer.on('job-event', (_e, data) => cb(data)),
  onClipboardUrl: (cb) => ipcRenderer.on('clipboard-url', (_e, url) => cb(url)),
  onBridgeJob: (cb) => ipcRenderer.on('bridge-job', (_e, job) => cb(job)),
});
