const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('radar', {
  select: (name) => ipcRenderer.send('select', name),
  onActive: (callback) => ipcRenderer.on('active', (_e, name) => callback(name)),
});
