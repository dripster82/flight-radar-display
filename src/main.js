// Flight Radar Display: one window, a tab bar, and a full view per tab.
// All views stay loaded so switching tabs is instant and FR24 keeps its state.
const { app, BaseWindow, WebContentsView, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const wifi = require('./wifi');
const gps = require('./gps');
const feed = require('./feed');
const display = require('./display');

const config = require('../config.json');
if (process.env.LOCAL_RADAR_URL) config.localRadarUrl = process.env.LOCAL_RADAR_URL;
if (process.env.KIOSK) config.kiosk = process.env.KIOSK === '1';
if (process.env.HOME_LOCATION) {
  const [latitude, longitude] = process.env.HOME_LOCATION.split(',').map(Number);
  config.home = { latitude, longitude };
}
const home = config.home && Number.isFinite(config.home.latitude) && Number.isFinite(config.home.longitude)
  ? { latitude: config.home.latitude, longitude: config.home.longitude }
  : null;

// The 7" Touch Display 2 is 1280x720 in landscape, which is so dense that pages drawn at 100%
// are too small to tap. Zooming everything gives roughly an 850x480 layout with finger-sized targets.
const ZOOM = Number(config.zoom) || 1;
const BAR_HEIGHT = Math.round(44 * ZOOM);
const RETRY_MS = 5000;
const LOCATION_EVERY_MS = 2000;
const STATUS_EVERY_MS = 5000;
const GPS_FRESH_MS = 15000;
const PRELOAD = path.join(__dirname, 'preload.js');
const captureDir = app.commandLine.getSwitchValue('capture'); // dev only: save a PNG of each tab, then quit

// Sites treat an "Electron" user agent as an unsupported browser; present as plain Chrome.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|flight-radar-display)\/\S+/g, '');

const tabs = {
  local: { url: config.localRadarUrl },
  // A named persistent partition keeps the FR24 login across restarts.
  fr24: { url: config.fr24Url, partition: 'persist:fr24' },
  // Our own settings page (Wi-Fi and brightness); only pages with `file` get the preload bridge.
  wifi: { file: 'wifi.html' },
};
let active = tabs[config.startTab] ? config.startTab : 'local';
let win, bar;
let gpsFix = null;      // latest GPS position
let gpsFixAt = 0;       // when it arrived
let feedPaused = null;  // true while away from home; null until the first GPS fix decides

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
  tabs.wifi.view.webContents.send('active', active); // lets the settings page refresh when shown
}

function createTab(tab) {
  const webPreferences = tab.file ? { preload: PRELOAD } : tab.partition ? { partition: tab.partition } : {};
  tab.view = new WebContentsView({ webPreferences });
  const wc = tab.view.webContents;
  wc.on('did-finish-load', () => wc.setZoomFactor(ZOOM)); // zoom is per site, so set it on every load
  tab.load = () => (tab.file
    ? wc.loadFile(path.join(__dirname, tab.file))
    : wc.loadURL(tab.url).catch(() => {})); // failures are handled by did-fail-load
  // There is no way back from a popup on a kiosk, so open links in place instead.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  // If a site cannot load (receiver still starting, no network), show a notice and keep retrying.
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || url.startsWith('file:')) return; // -3 = navigation aborted
    wc.loadFile(path.join(__dirname, 'offline.html'));
    clearTimeout(tab.retry); // one retry chain per tab, however many loads failed
    tab.retry = setTimeout(tab.load, RETRY_MS);
  });
  tab.load();
  win.contentView.addChildView(tab.view);
}

// Stops the FR24 feeder when the GPS shows the device is away from home, and starts it again
// when it is back. Does nothing without both a home position and a GPS fix.
function pauseFeedWhenAway(position) {
  if (!home) return;
  const away = feed.distanceKm(home, position) > (Number(config.awayKm) || 25);
  if (away === feedPaused) return;
  feedPaused = away;
  feed.setRunning(!away);
}

// Gives the FR24 page a browser location so its "my location" button works: the live GPS fix
// when there is one, otherwise the home coordinates from config. The browser has no other
// location source, so with neither of these the button can only spin.
function shareLocationWithFr24() {
  const wc = tabs.fr24.view.webContents;
  // Location is the only permission the site may have; everything else is refused.
  wc.session.setPermissionRequestHandler((_wc, permission, allow) => allow(permission === 'geolocation'));
  // The browser only answers a page's location request at the moment a position is set, so a
  // position set once would answer the first request and leave every later one waiting forever.
  // Re-sending it on a timer keeps the button working and also survives page reloads.
  setInterval(() => {
    const current = gpsFix || (home && { ...home, accuracy: 100 });
    if (!current) return;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach();
      wc.debugger.sendCommand('Emulation.setGeolocationOverride', current).catch(() => {});
    } catch { /* view not ready yet; the next tick tries again */ }
  }, LOCATION_EVERY_MS);
}

// The receiver is healthy when the local map's aircraft data is being rewritten every second.
async function receiverStatus() {
  try {
    const res = await fetch(new URL('data/aircraft.json', config.localRadarUrl), { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    if (Math.abs(Date.now() / 1000 - data.now) > 30) return { state: 'bad' };
    return { state: 'ok', count: data.aircraft.length };
  } catch {
    return { state: 'bad' };
  }
}

// Every light reflects a real check; nothing here is assumed.
async function sendStatus() {
  const [receiver, feeder, network] = await Promise.all([receiverStatus(), feed.status(), wifi.status()]);
  if (feeder.state === 'off' && feedPaused) feeder.state = 'paused';
  const gpsState = { state: Date.now() - gpsFixAt < GPS_FRESH_MS ? 'ok' : 'bad' };
  if (!bar.webContents.isDestroyed()) bar.webContents.send('status', { receiver, feed: feeder, gps: gpsState, wifi: network });
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
    width: 1280,
    height: 720,
    useContentSize: true,
    kiosk: config.kiosk,
    backgroundColor: '#0b1622',
    title: 'Flight Radar',
  });

  bar = new WebContentsView({ webPreferences: { preload: PRELOAD } });
  win.contentView.addChildView(bar);
  bar.webContents.loadFile(path.join(__dirname, 'tabbar.html'));
  bar.webContents.on('did-finish-load', () => {
    bar.webContents.setZoomFactor(ZOOM);
    bar.webContents.send('active', active);
    sendStatus();
  });

  Object.values(tabs).forEach(createTab);
  layout();
  select(active);

  display.init(config, app.getPath('userData'));
  gps.watch((position) => {
    gpsFix = position;
    gpsFixAt = Date.now();
    pauseFeedWhenAway(position);
  });
  shareLocationWithFr24();
  setInterval(sendStatus, STATUS_EVERY_MS);

  win.on('resize', layout);
  ipcMain.on('select', (_e, name) => {
    // Tapping the tab you are already on takes it back to its home page.
    if (name === active && tabs[name]) tabs[name].load();
    select(name);
  });
  // Errors come back as { error } so the page can show the message as plain text.
  const reply = (work) => work.then((result) => ({ result }), (err) => ({ error: err.message }));
  ipcMain.handle('wifi:list', () => reply(wifi.list()));
  ipcMain.handle('wifi:connect', (_e, ssid, password) => reply(wifi.connect(ssid, password).then(sendStatus)));
  ipcMain.handle('wifi:forget', (_e, ssid) => reply(wifi.forget(ssid).then(sendStatus)));
  ipcMain.handle('display:get', () => display.get());
  ipcMain.handle('display:set', (_e, patch) => display.update(patch || {}));
  if (captureDir) captureAndQuit();
});

app.on('window-all-closed', () => app.quit());
