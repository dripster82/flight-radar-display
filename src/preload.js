// Bridge for our own pages only (tab bar and Wi-Fi screen); web sites never get it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('radar', {
  select: (name) => ipcRenderer.send('select', name),
  onActive: (callback) => ipcRenderer.on('active', (_e, name) => callback(name)),
  wifiList: () => ipcRenderer.invoke('wifi:list'),
  wifiConnect: (ssid, password) => ipcRenderer.invoke('wifi:connect', ssid, password),
});
