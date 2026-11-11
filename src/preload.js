// Bridge for our own pages only (tab bar and settings screen); web sites never get it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('radar', {
  select: (name) => ipcRenderer.send('select', name),
  onActive: (callback) => ipcRenderer.on('active', (_e, name) => callback(name)),
  onStatus: (callback) => ipcRenderer.on('status', (_e, status) => callback(status)),
  wifiList: () => ipcRenderer.invoke('wifi:list'),
  wifiConnect: (ssid, password) => ipcRenderer.invoke('wifi:connect', ssid, password),
  wifiForget: (ssid) => ipcRenderer.invoke('wifi:forget', ssid),
  homeGet: () => ipcRenderer.invoke('home:get'),
  homeSet: () => ipcRenderer.invoke('home:set'),
  homeFeedWait: (value) => ipcRenderer.invoke('home:feedWait', value),
  displayGet: () => ipcRenderer.invoke('display:get'),
  displaySet: (patch) => ipcRenderer.invoke('display:set', patch),
  keyboardKey: (key) => ipcRenderer.send('keyboard:key', key),
  tabHome: (name) => ipcRenderer.send('tab:home', name),
  fr24SignOut: () => ipcRenderer.send('fr24:signOut'),
  welcomeGet: () => ipcRenderer.invoke('welcome:get'),
  welcomeDone: () => ipcRenderer.send('welcome:done'),
});

// The colour theme is set on <html> before the page draws, and updated live when it is changed in Settings.
const applyTheme = (theme) => { if (document.documentElement) document.documentElement.dataset.theme = theme; };
applyTheme(ipcRenderer.sendSync('theme:get'));
window.addEventListener('DOMContentLoaded', () => applyTheme(ipcRenderer.sendSync('theme:get')));
ipcRenderer.on('theme', (_e, theme) => applyTheme(theme));
