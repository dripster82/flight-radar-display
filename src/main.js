// Flight Radar Display: one window, a tab bar, and a full view per tab.
// All views stay loaded so switching tabs is instant and FR24 keeps its state.
const { app, BaseWindow, WebContentsView, ipcMain, session } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const wifi = require('./wifi');
const gps = require('./gps');
const feed = require('./feed');
const display = require('./display');

// With power-cut protection on, the system is read-only and the app's data lives in separate
// writable storage areas (see scripts/data-area.sh): the browser's data, which holds the
// Flightradar24 sign-in, in one, and the settings files in another. The web cache is kept out of
// storage, in memory: it is large, rewritten constantly, and not worth keeping.
if (process.env.FLIGHT_RADAR_DATA_DIR) {
  app.setPath('userData', process.env.FLIGHT_RADAR_DATA_DIR);
  app.commandLine.appendSwitch('disk-cache-dir', path.join(os.tmpdir(), 'flight-radar-cache'));
}
const SETTINGS_DIR = process.env.FLIGHT_RADAR_SETTINGS_DIR || app.getPath('userData');

// After something in storage changes, a fresh backup of that area is requested, so the change is
// in a backup within seconds. Several changes close together make one backup. This is the ONLY
// thing that causes a backup: there is none on a schedule or at start-up, because each one
// overwrites an older good backup and is a moment when a power cut could spoil one.
// (The backup itself is done by scripts/data-area.sh, which checks the area first and the copy after.)
const backupTimers = {};
function requestBackup(area, prepare) {
  if (!process.env.FLIGHT_RADAR_SETTINGS_DIR) return; // protection is off: there are no storage areas
  clearTimeout(backupTimers[area]);
  backupTimers[area] = setTimeout(async () => {
    if (prepare) await prepare().catch(() => {});
    const stand_in = process.env.FLIGHT_RADAR_BACKUP_CMD; // dev stand-in
    const [file, args] = stand_in ? [stand_in, [area]] : ['sudo', ['-n', 'systemctl', 'start', `flight-radar-backup@${area}.service`]];
    execFile(file, args, { timeout: 120000 }, () => {});
  }, 3000);
}

// The Flightradar24 sign-in is written by the browser, not by the app, so the app watches for it
// changing: these are the cookies Flightradar24 sets on signing in and clears on signing out.
// (The site's many other cookies change constantly and are not worth a backup.) The browser is
// told to write its cookies to storage first, so the backup holds the new sign-in.
const SIGN_IN_COOKIES = ['_frr', '_frc'];
function backUpSignInWhenItChanges() {
  const { cookies } = session.fromPartition(tabs.fr24.partition);
  cookies.on('changed', (_event, cookie) => {
    if (SIGN_IN_COOKIES.includes(cookie.name) && cookie.domain.endsWith('flightradar24.com')) {
      requestBackup('browser', () => cookies.flushStore());
    }
  });
}
// Left by the boot script when it had to restore an area from a backup or from the defaults.
const RESTORED_NOTE = process.env.FLIGHT_RADAR_RESTORED_NOTE || '/run/flight-radar-data-restored';
const storageRestored = () => { try { return fs.readFileSync(RESTORED_NOTE, 'utf8').trim(); } catch { return null; } };

const config = require('../config.json');
if (process.env.LOCAL_RADAR_URL) config.localRadarUrl = process.env.LOCAL_RADAR_URL;
if (process.env.KIOSK) config.kiosk = process.env.KIOSK === '1';
if (process.env.HOME_LOCATION) {
  const [latitude, longitude] = process.env.HOME_LOCATION.split(',').map(Number);
  config.home = { latitude, longitude };
}
let home = config.home && Number.isFinite(config.home.latitude) && Number.isFinite(config.home.longitude)
  ? { latitude: config.home.latitude, longitude: config.home.longitude }
  : null;
// Choices made on the device's Settings screen are kept in the app's data folder and replace
// the matching values in config.json: the home position ("Set home to GPS position", used after
// moving house) and whether the feed waits for GPS.
const DEVICE_FILE = path.join(SETTINGS_DIR, 'location.json');
let onDevice = {};
try { onDevice = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8')); } catch { /* nothing chosen on the device yet */ }
if (!process.env.HOME_LOCATION && onDevice.home && Number.isFinite(onDevice.home.latitude) && Number.isFinite(onDevice.home.longitude)) {
  home = onDevice.home;
}
let feedRequiresGps = typeof onDevice.feedRequiresGps === 'boolean' ? onDevice.feedRequiresGps : config.feedRequiresGps !== false;
const saveOnDevice = (patch) => {
  onDevice = { ...onDevice, ...patch };
  // Written to a new file and then swapped in, so a power cut leaves the old file or the new one, never half of one.
  fs.writeFileSync(`${DEVICE_FILE}.tmp`, JSON.stringify(onDevice));
  fs.renameSync(`${DEVICE_FILE}.tmp`, DEVICE_FILE);
  requestBackup('settings');
};

// The 7" Touch Display 2 is 1280x720 in landscape, which is so dense that pages drawn at 100%
// are too small to tap. Zooming everything gives roughly an 850x480 layout with finger-sized targets.
const ZOOM = Number(config.zoom) || 1;
const BAR_HEIGHT = Math.round(52 * ZOOM);
const RETRY_MS = 5000;
const LOCATION_EVERY_MS = 2000;
const STATUS_EVERY_MS = 5000;
const GPS_FRESH_MS = 15000;
const FIXES_TO_TRUST = 5; // consecutive GPS fixes that must agree before the feeder is started or stopped
const PRELOAD = path.join(__dirname, 'preload.js');
const WEB_PRELOAD = path.join(__dirname, 'web-preload.js'); // for the web pages in the map tabs; see that file
const KEYBOARD_HEIGHT = Math.round(206 * ZOOM);
const captureDir = app.commandLine.getSwitchValue('capture'); // dev only: save a PNG of each tab, then quit

// Sites treat an "Electron" user agent as an unsupported browser; present as plain Chrome.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|flight-radar-display)\/\S+/g, '');

// The local map's address with the chosen map style and extras (labels, trails, ...) added.
const localUrl = () => `${config.localRadarUrl}${config.localRadarUrl.includes('?') ? '&' : '?'}${display.mapQuery()}`;
const UNIT_METRES = { km: 1000, miles: 1609.344, nautical: 1852 };
const UNIT_LABEL = { km: 'km', miles: 'mi', nautical: 'nmi' };

// For the "Radar scope" map style: once the local map has loaded, the wireframe-and-sweep overlay
// is run inside it. The outline data is public-domain Natural Earth coastlines and borders.
function addRadarScope(wc) {
  if (display.mapStyle().id !== 'radar' || wc.getURL().startsWith('file:')) return;
  const unit = UNIT_METRES[config.distanceUnits] ? config.distanceUnits : 'nautical';
  const radarConfig = { rings: config.rangeRings || [], ringUnit: UNIT_LABEL[unit], metresPerUnit: UNIT_METRES[unit] };
  const outlines = fs.readFileSync(path.join(__dirname, 'outlines.json'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, 'radar-scope.js'), 'utf8');
  wc.executeJavaScript(`window.__radarOutlines = ${outlines}; window.__radarConfig = ${JSON.stringify(radarConfig)};\n${script}`).catch(() => {});
}

// Settings decides which extras the local map shows. The map also keeps its own memory of some of
// them, which would otherwise bring back one that has been switched off; that memory is cleared
// and the map loaded once more.
function forgetMapExtras(wc) {
  const keys = display.mapForget();
  if (!keys.length || wc.getURL().startsWith('file:')) return;
  wc.executeJavaScript(`(() => { let had = false; for (const key of ${JSON.stringify(keys)}) { if (localStorage.getItem(key) !== null) { localStorage.removeItem(key); had = true; } } if (had) location.reload(); })()`).catch(() => {});
}

const tabs = {
  local: { url: config.localRadarUrl, onLoad: (wc) => { forgetMapExtras(wc); addRadarScope(wc); } },
  // A named persistent partition keeps the FR24 login across restarts.
  fr24: { url: config.fr24Url, partition: 'persist:fr24' },
  // Our own settings page (Wi-Fi and brightness); only pages with `file` get the preload bridge.
  wifi: { file: 'wifi.html' },
};
let active = tabs[config.startTab] ? config.startTab : 'local';
let win, bar, welcomeView, keyboardView;
let typingInto = null;  // the web page the on-screen keyboard is typing into, while it is shown
let gpsFix = null;      // latest GPS position
let gpsFixAt = 0;       // when it arrived
let feedPaused = null;  // true while away from home; null until GPS has decided
let verdict = { away: null, count: 0 }; // the run of matching GPS fixes seen so far
// With a home position set, the feeder stays off after boot until GPS confirms the device is at home.
const feedWaitsForGps = () => Boolean(home) && feedRequiresGps;

function layout() {
  const { width, height } = win.getContentBounds();
  if (welcomeView) welcomeView.setBounds({ x: 0, y: 0, width, height });
  bar.setBounds({ x: 0, y: 0, width, height: BAR_HEIGHT });
  // While the keyboard is up, the page being typed into is made shorter so nothing hides behind it.
  for (const tab of Object.values(tabs)) {
    const keyboard = typingInto === tab.view.webContents ? KEYBOARD_HEIGHT : 0;
    tab.view.setBounds({ x: 0, y: BAR_HEIGHT, width, height: height - BAR_HEIGHT - keyboard });
  }
  keyboardView.setBounds({ x: 0, y: height - KEYBOARD_HEIGHT, width, height: KEYBOARD_HEIGHT });
}

// The on-screen keyboard for web pages. There is no physical keyboard, so without this nothing
// could be typed into the Flightradar24 sign-in or its search box. A page says when one of its text
// boxes is touched (web-preload.js); the keyboard is docked under it, and each key pressed
// (keyboard.html) is typed into that page as if from a real keyboard.
function showKeyboard(wc) {
  const tab = tabs[active];
  if (tab.file || wc !== tab.view.webContents || typingInto === wc) return; // only the page on screen
  typingInto = wc;
  keyboardView.setVisible(true);
  layout();
}
function hideKeyboard() {
  if (!typingInto) return;
  typingInto = null;
  keyboardView.setVisible(false);
  layout();
}
function typeKey({ text, key } = {}) {
  if (!typingInto) return;
  if (key === 'hide') return hideKeyboard();
  typingInto.focus(); // touching the key took focus away from the page; give it back before typing
  if (typeof text === 'string' && text.length === 1) {
    typingInto.sendInputEvent({ type: 'char', keyCode: text });
  } else if (key === 'Backspace' || key === 'Enter') {
    typingInto.sendInputEvent({ type: 'keyDown', keyCode: key });
    if (key === 'Enter') typingInto.sendInputEvent({ type: 'char', keyCode: '\r' });
    typingInto.sendInputEvent({ type: 'keyUp', keyCode: key });
  }
}

function select(name) {
  if (!tabs[name]) return;
  hideKeyboard();
  active = name;
  for (const [key, tab] of Object.entries(tabs)) tab.view.setVisible(key === active);
  bar.webContents.send('active', active);
  tabs.wifi.view.webContents.send('active', active); // lets the settings page refresh when shown
}

// A message shown once over the whole screen, the first time the device is switched on: the
// "welcome" title and message in config.json. Touching the screen dismisses it for good (the
// choice is kept with the other settings). `scripts/protect.sh enable --show-welcome` arms it again.
function showWelcomeOnce() {
  const text = config.welcome || {};
  if (!(text.title || text.message) || display.get().welcomeShown) return;
  welcomeView = new WebContentsView({ webPreferences: { preload: PRELOAD } });
  win.contentView.addChildView(welcomeView); // added last, so it sits above the tabs
  welcomeView.webContents.on('did-finish-load', () => welcomeView.webContents.setZoomFactor(ZOOM));
  welcomeView.webContents.loadFile(path.join(__dirname, 'welcome.html'));
  ipcMain.handle('welcome:get', () => ({ title: String(text.title || ''), message: String(text.message || '') }));
  ipcMain.once('welcome:done', () => {
    win.contentView.removeChildView(welcomeView);
    welcomeView.webContents.close();
    welcomeView = null;
    display.update({ welcomeShown: true });
    requestBackup('settings');
  });
}

function createTab(tab) {
  // Our own pages get the app's bridge. Web pages get only the keyboard watcher, in their frames too
  // (a sign-in form is often inside one).
  const webPreferences = tab.file ? { preload: PRELOAD }
    : { preload: WEB_PRELOAD, nodeIntegrationInSubFrames: true, ...(tab.partition ? { partition: tab.partition } : {}) };
  tab.view = new WebContentsView({ webPreferences });
  const wc = tab.view.webContents;
  wc.on('did-finish-load', () => {
    wc.setZoomFactor(ZOOM); // zoom is per site, so set it on every load
    if (tab.onLoad) tab.onLoad(wc);
  });
  tab.load = () => (tab.file
    ? wc.loadFile(path.join(__dirname, tab.file))
    : wc.loadURL(tab.url).catch(() => {})); // failures are handled by did-fail-load
  wc.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument && typingInto === wc) hideKeyboard(); });
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

// The FR24 feeder is registered at a fixed location, so it only runs while GPS shows the device is
// at home: it is started once several fixes in a row agree it is within awayKm of home, and stopped
// once they agree it is not. A single odd fix changes nothing, and losing GPS later changes nothing
// either (the device has not moved just because the signal dropped).
function controlFeedFromGps(position) {
  if (!home) return;
  const away = feed.distanceKm(home, position) > (Number(config.awayKm) || 5);
  if (away !== verdict.away) verdict = { away, count: 0 };
  if (++verdict.count < FIXES_TO_TRUST || away === feedPaused) return;
  feedPaused = away;
  feed.setRunning(!away);
}

const freshGps = () => (gpsFix && Date.now() - gpsFixAt < GPS_FRESH_MS ? gpsFix : null);

function homeInfo() {
  const gpsNow = freshGps();
  return {
    home,
    feedRequiresGps,
    hasGps: Boolean(gpsNow),
    distanceKm: home && gpsNow ? feed.distanceKm(home, gpsNow) : null,
  };
}

// Tells the decoder where the receiver is, for when it has no GPS fix of its own.
function setReceiverLocation({ latitude, longitude }) {
  const command = process.env.READSB_SET_LOCATION; // dev stand-in
  const [file, args] = command
    ? [command, [String(latitude), String(longitude)]]
    : ['sudo', ['-n', 'readsb-set-location', String(latitude), String(longitude)]];
  return new Promise((resolve) => execFile(file, args, { timeout: 30000 }, (err) => resolve(!err)));
}

// For after a house move: makes the current GPS position the new home. The location registered
// with Flightradar24 is changed on their website; this brings the device into line with it, so
// the feeder runs at the new address and no longer at the old one.
async function setHomeToGps() {
  const gpsNow = freshGps();
  if (!gpsNow) throw new Error('No GPS fix yet. Try again near a window.');
  home = { latitude: Number(gpsNow.latitude.toFixed(5)), longitude: Number(gpsNow.longitude.toFixed(5)) };
  saveOnDevice({ home });
  feedPaused = null;                  // decide the feeder again against the new home
  verdict = { away: null, count: 0 };
  const receiverUpdated = await setReceiverLocation(home);
  return { ...homeInfo(), receiverUpdated };
}

// Settings switch. Off: the feeder runs without waiting for GPS (for a spot where the GPS cannot
// get a fix), though GPS placing the device away from home still stops it.
function setFeedRequiresGps(value) {
  feedRequiresGps = Boolean(value);
  saveOnDevice({ feedRequiresGps });
  if (!feedRequiresGps && feedPaused === null) feed.setRunning(true); // was being held back; let it go
  sendStatus();
  return homeInfo();
}

// Gives both map pages a browser location: the live GPS fix when there is one, otherwise the home
// coordinates. The browser has no other location source, so without this any page feature that
// asks "where am I" waits forever: Flightradar24's "my location" button, and the local map's
// Home (H) button, which asks for the location before it re-centres.
function shareLocationWithMaps() {
  const pages = [tabs.local.view.webContents, tabs.fr24.view.webContents];
  // Location is the only permission these pages may have; everything else is refused.
  for (const wc of pages) wc.session.setPermissionRequestHandler((_wc, permission, allow) => allow(permission === 'geolocation'));
  // The browser only answers a page's location request at the moment a position is set, so a
  // position set once would answer the first request and leave every later one waiting forever.
  // Re-sending it on a timer keeps the buttons working and also survives page reloads.
  setInterval(() => {
    const current = gpsFix || (home && { ...home, accuracy: 100 });
    if (!current) return;
    for (const wc of pages) {
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach();
        wc.debugger.sendCommand('Emulation.setGeolocationOverride', current).catch(() => {});
      } catch { /* view not ready yet; the next tick tries again */ }
    }
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
  else if (feeder.state === 'off' && feedPaused === null && feedWaitsForGps()) feeder.state = 'waiting';
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
  // Before any page loads: each of our pages asks for the theme as it starts.
  display.init(config, SETTINGS_DIR);
  backUpSignInWhenItChanges();
  ipcMain.on('theme:get', (event) => { event.returnValue = display.get().theme; });

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

  tabs.local.url = localUrl(); // needs the saved map style, which display.init has just loaded
  Object.values(tabs).forEach(createTab);
  keyboardView = new WebContentsView({ webPreferences: { preload: PRELOAD } });
  keyboardView.webContents.on('did-finish-load', () => keyboardView.webContents.setZoomFactor(ZOOM));
  keyboardView.webContents.loadFile(path.join(__dirname, 'keyboard.html'));
  keyboardView.setVisible(false);
  win.contentView.addChildView(keyboardView);
  showWelcomeOnce();
  layout();
  select(active);

  gps.watch((position) => {
    gpsFix = position;
    gpsFixAt = Date.now();
    controlFeedFromGps(position);
  });
  // Nothing else starts the feeder at boot (see scripts/install-fr24.sh), so when it is not
  // waiting for GPS it is started here.
  if (!feedWaitsForGps()) feed.setRunning(true);
  shareLocationWithMaps();
  setInterval(sendStatus, STATUS_EVERY_MS);

  win.on('resize', layout);
  ipcMain.on('select', (_e, name) => {
    // Tapping the tab you are already on takes it back to its home page.
    if (name === active && tabs[name]) tabs[name].load();
    select(name);
  });
  ipcMain.on('keyboard:show', (event) => showKeyboard(event.sender));
  ipcMain.on('keyboard:hide', (event) => { if (event.sender === typingInto) hideKeyboard(); });
  ipcMain.on('keyboard:key', (event, key) => { if (event.sender === keyboardView.webContents) typeKey(key); });
  // The way out when a map tab is stuck on a sign-in page or has wandered off to another site:
  // back to that tab's start page (the home button on the tab bar, and a button in Settings).
  ipcMain.on('tab:home', (_e, name) => {
    if (!tabs[name] || tabs[name].file) return;
    tabs[name].load();
    select(name);
  });
  // And the stronger version for Flightradar24: forget the sign-in and everything else the site
  // has stored, then start again from its front page.
  ipcMain.on('fr24:signOut', async () => {
    await session.fromPartition(tabs.fr24.partition).clearStorageData().catch(() => {});
    tabs.fr24.load();
    select('fr24');
  });
  // Errors come back as { error } so the page can show the message as plain text.
  const reply = (work) => work.then((result) => ({ result }), (err) => ({ error: err.message }));
  ipcMain.handle('wifi:list', () => reply(wifi.list()));
  const wifiChanged = () => { requestBackup('wifi'); return sendStatus(); };
  ipcMain.handle('wifi:connect', (_e, ssid, password) => reply(wifi.connect(ssid, password).then(wifiChanged)));
  ipcMain.handle('wifi:forget', (_e, ssid) => reply(wifi.forget(ssid).then(wifiChanged)));
  ipcMain.handle('home:get', () => homeInfo());
  ipcMain.handle('home:set', () => reply(setHomeToGps()));
  ipcMain.handle('home:feedWait', (_e, value) => setFeedRequiresGps(value));
  ipcMain.handle('display:get', () => ({ ...display.get(), storageRestored: storageRestored() }));
  ipcMain.handle('display:set', (_e, patch) => {
    const before = localUrl();
    const result = display.update(patch || {});
    requestBackup('settings');
    bar.webContents.send('theme', result.theme); // the settings page restyles itself; the tab bar is told here
    if (localUrl() !== before) { // reload the local map with its new style or extras
      tabs.local.url = localUrl();
      tabs.local.load();
    }
    return result;
  });
  if (captureDir) captureAndQuit();
});

app.on('window-all-closed', () => app.quit());
