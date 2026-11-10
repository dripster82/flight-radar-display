// Bridge for our own pages only (tab bar and settings screen); web sites never get it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('radar', {
  select: (name) => ipcRenderer.send('select', name),
  onActive: (callback) => ipcRenderer.on('active', (_e, name) => callback(name)),
  onStatus: (callback) => ipcRenderer.on('status', (_e, status) => callback(status)),
  wifiList: () => ipcRenderer.invoke('wifi:list'),
  wifiConnect: (ssid, password) => ipcRenderer.invoke('wifi:connect', ssid, password),
  wifiForget: (ssid) => ipcRenderer.invoke('wifi:forget', ssid),
  displayGet: () => ipcRenderer.invoke('display:get'),
  displaySet: (patch) => ipcRenderer.invoke('display:set', patch),
});
