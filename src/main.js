// Flight Radar Display: one window, a tab bar, and two full browser views.
// Both views stay loaded so switching tabs is instant and FR24 keeps its state.
const { app, BaseWindow, WebContentsView, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const config = require('../config.json');
if (process.env.LOCAL_RADAR_URL) config.localRadarUrl = process.env.LOCAL_RADAR_URL;
if (process.env.KIOSK) config.kiosk = process.env.KIOSK === '1';

const BAR_HEIGHT = 44;
const RETRY_MS = 5000;
const captureDir = app.commandLine.getSwitchValue('capture'); // dev only: save a PNG of each tab, then quit

// Sites treat an "Electron" user agent as an unsupported browser; present as plain Chrome.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|flight-radar-display)\/\S+/g, '');

const tabs = {
  local: { url: config.localRadarUrl },
  // A named persistent partition keeps the FR24 login across restarts.
  fr24: { url: config.fr24Url, partition: 'persist:fr24' },
};
let active = tabs[config.startTab] ? config.startTab : 'local';
let win, bar;

function layout() {
  const { width, height } = win.getContentBounds();
  bar.setBounds({ x: 0, y: 0, width, height: BAR_HEIGHT });
  for (const tab of Object.values(tabs)) {
    tab.view.setBounds({ x: 0, y: BAR_HEIGHT, width, height: height - BAR_HEIGHT });
  }
}

function select(name) {
  if (!tabs[name]) return;
  active = name;
  for (const [key, tab] of Object.entries(tabs)) tab.view.setVisible(key === active);
  bar.webContents.send('active', active);
}

function createTab(tab) {
  tab.view = new WebContentsView({
    webPreferences: tab.partition ? { partition: tab.partition } : {},
  });
  const wc = tab.view.webContents;
  // There is no way back from a popup on a kiosk, so open links in place instead.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  // If the page cannot load (receiver still starting, no network), show a notice and keep retrying.
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || url.startsWith('file:')) return; // -3 = navigation aborted
    wc.loadFile(path.join(__dirname, 'offline.html'));
    clearTimeout(tab.retry); // one retry chain per tab, however many loads failed
    tab.retry = setTimeout(() => wc.loadURL(tab.url).catch(() => {}), RETRY_MS);
  });
  wc.loadURL(tab.url).catch(() => {}); // failures are handled by did-fail-load
  win.contentView.addChildView(tab.view);
}

async function captureAndQuit() {
  fs.mkdirSync(captureDir, { recursive: true });
  await new Promise((r) => setTimeout(r, 12000));
  for (const name of Object.keys(tabs)) {
    select(name);
    await new Promise((r) => setTimeout(r, 1500));
    const wc = tabs[name].view.webContents;
    // A capture fails if the page navigates mid-shot (the offline retry does); try once more.
    const image = await wc.capturePage().catch(() => new Promise((r) => setTimeout(r, 1000)).then(() => wc.capturePage()));
    fs.writeFileSync(path.join(captureDir, `${name}.png`), image.toPNG());
  }
  fs.writeFileSync(path.join(captureDir, 'bar.png'), (await bar.webContents.capturePage()).toPNG());
  app.quit();
}

app.whenReady().then(() => {
  win = new BaseWindow({
    width: 800,
    height: 480,
    useContentSize: true,
    kiosk: config.kiosk,
    backgroundColor: '#0b1622',
    title: 'Flight Radar',
  });

  bar = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.contentView.addChildView(bar);
  bar.webContents.loadFile(path.join(__dirname, 'tabbar.html'));
  bar.webContents.on('did-finish-load', () => bar.webContents.send('active', active));

  Object.values(tabs).forEach(createTab);
  layout();
  select(active);

  win.on('resize', layout);
  ipcMain.on('select', (_e, name) => {
    // Tapping the tab you are already on takes it back to its home page.
    if (name === active && tabs[name]) tabs[name].view.webContents.loadURL(tabs[name].url).catch(() => {});
    select(name);
  });
  if (captureDir) captureAndQuit();
});

app.on('window-all-closed', () => app.quit());
