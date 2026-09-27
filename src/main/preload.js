'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scribe', {
  info: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
  setKey: (provider, value) => ipcRenderer.invoke('settings:setKey', { provider, value }),
  testKey: (provider) => ipcRenderer.invoke('settings:testKey', { provider }),
  pickFiles: () => ipcRenderer.invoke('dialog:files'),
  pickOutputDir: () => ipcRenderer.invoke('dialog:outputDir'),
  startJob: (payload) => ipcRenderer.invoke('job:start', payload),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  liveStart: () => ipcRenderer.invoke('live:start'),
  liveChunk: (bytes) => ipcRenderer.invoke('live:chunk', bytes),
  liveStop: () => ipcRenderer.invoke('live:stop'),
  liveCancel: () => ipcRenderer.invoke('live:cancel'),
  liveSummarize: (transcript) => ipcRenderer.invoke('live:summarize', { transcript }),
  onLiveEvent: (cb) => {
    const handler = (_e, event) => cb(event);
    ipcRenderer.on('live:event', handler);
    return () => ipcRenderer.removeListener('live:event', handler);
  },
  saveExport: (payload) => ipcRenderer.invoke('export:save', payload),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:showItemInFolder', p),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  onEvent: (cb) => {
    const handler = (_e, event) => cb(event);
    ipcRenderer.on('job:event', handler);
    return () => ipcRenderer.removeListener('job:event', handler);
  }
});
