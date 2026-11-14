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
const location = require('./location');
const log = require('./log');
const update = require('./update');
const fr24 = require('./fr24');

// With power-cut protection on, the system is read-only and the app's data lives in separate
// writable storage areas (see scripts/data-area.sh): the browser's data, which holds the
// Flightradar24 sign-in, in one, and the settings files in another.
const DATA_DIR = process.env.FLIGHT_RADAR_DATA_DIR || null;
if (DATA_DIR) app.setPath('userData', DATA_DIR);
const SETTINGS_DIR = process.env.FLIGHT_RADAR_SETTINGS_DIR || app.getPath('userData');

// The diagnostic log (see log.js). scripts/kiosk.sh names the folder; in development it sits with the settings.
log.init(process.env.FLIGHT_RADAR_LOG_DIR || path.join(SETTINGS_DIR, 'logs'));
const STARTED_AT = Date.now();
const sinceStart = () => `${((Date.now() - STARTED_AT) / 1000).toFixed(1)} s after the app started`;
// The web cache (map tiles, the Flightradar24 site's files, and the compiled form of their scripts)
// is large and rewritten constantly, so it must not live in the sign-in's storage area, which is
// small and writes everything straight to the card. It has an area of its own (FLIGHT_RADAR_CACHE_DIR,
// set by scripts/kiosk.sh), so pages open quickly after a restart instead of being downloaded
// again; without that area it goes to memory and is lost at power-off. The browser engine has no
// setting for where a profile's cache goes (it is always inside the profile's folder, and the old
// --disk-cache-dir switch is ignored), so each cache folder is replaced by a link to the real
// place. This is redone at every start, because the engine replaces a link with a plain folder if
// it ever throws a cache away. There are two profiles, the local map's and Flightradar24's
// (Partitions/fr24, from the partition name in `tabs`), each with a page cache and a script cache,
// and the size limit applies to each of the four. A full area does no harm: the engine just stops adding to it.
// (Linux only: on a Mac the engine's own safety rules stop it writing through such a link, and
// there the cache simply stays with the browser data.)
const CACHE_DIR = DATA_DIR && process.platform === 'linux' ? process.env.FLIGHT_RADAR_CACHE_DIR || path.join(os.tmpdir(), 'flight-radar-cache') : null;
const CACHE_MB_EACH = Number(process.env.FLIGHT_RADAR_CACHE_MB) || 24;
function linkCaches() {
  for (const [profile, folder] of [['', 'local'], ['Partitions/fr24', 'fr24']]) {
    for (const name of ['Cache', 'Code Cache']) {
      const link = path.join(DATA_DIR, profile, name);
      const target = path.join(CACHE_DIR, folder, name);
      try {
        fs.mkdirSync(target, { recursive: true });
        fs.mkdirSync(path.dirname(link), { recursive: true });
        let pointsAt = null;
        try { pointsAt = fs.readlinkSync(link); } catch { /* missing, or a plain folder */ }
        if (pointsAt === target) continue;
        fs.rmSync(link, { recursive: true, force: true });
        fs.symlinkSync(target, link);
      } catch (err) {
        log('error', `web cache: could not link ${link} to ${target}: ${err.message}`);
      }
    }
  }
}
if (CACHE_DIR) {
  app.commandLine.appendSwitch('disk-cache-size', String(CACHE_MB_EACH * 1024 * 1024));
  linkCaches();
}
log('start', `app ${app.getVersion()}, Electron ${process.versions.electron}, ${process.platform} ${process.arch};`,
  `power-cut protection ${process.env.FLIGHT_RADAR_SETTINGS_DIR ? 'on' : 'off'};`,
  `web cache ${!CACHE_DIR ? 'kept with the browser data' : process.env.FLIGHT_RADAR_CACHE_DIR ? `kept in ${CACHE_DIR}, up to ${CACHE_MB_EACH} MB for each map` : 'in memory only, lost at power-off'}`);
execFile('git', ['-C', path.join(__dirname, '..'), 'log', '-1', '--format=%h %cs %s'], { timeout: 5000 }, (err, out) => { if (!err) log('start', `version ${out.trim()}`); });
// An error nobody caught would otherwise put a dialog box on a screen with no keyboard to dismiss it.
process.on('uncaughtException', (err) => log('error', err));
process.on('unhandledRejection', (err) => log('error', 'unhandled rejection:', err instanceof Error ? err : String(err)));

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
// Graphics acceleration. On the Pi the browser engine can decide the graphics chip is not on its
// approved list and draw everything with the processor instead, which makes the maps slow. These
// tell it to use the chip anyway. If the chip then fails, the engine falls back by itself; the log
// says which it ended up with ("gpu"). "graphicsAcceleration": false in config.json leaves it alone.
// Flightradar24's adverts are kept out, because they slow the device badly (see fr24.js).
const BLOCK_ADVERTS = config.fr24BlockAdverts !== false;
if (BLOCK_ADVERTS) fr24.hideAdvertSites(app);
log('start', `Flightradar24 adverts ${BLOCK_ADVERTS ? 'kept out' : 'allowed'}`);
if (process.platform === 'linux' && config.graphicsAcceleration !== false) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
}
let home = location.valid(config.home); // the home pin
// Choices made on the device's Settings screen are kept in the app's data folder and replace
// the matching values in config.json: the home pin (from a postcode, or "Set home to GPS
// position"), the position in use, and whether the feed waits for GPS.
const DEVICE_FILE = path.join(SETTINGS_DIR, 'location.json');
let onDevice = {};
try { onDevice = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8')); } catch { /* nothing chosen on the device yet */ }
if (!process.env.HOME_LOCATION && location.valid(onDevice.home)) home = location.valid(onDevice.home);
// The position the display works from: the home pin while the GPS is near it, otherwise a held GPS
// position (see location.js). Kept across restarts so it is right before the first GPS fix.
let current = (!process.env.HOME_LOCATION && location.valid(onDevice.current)) || home;
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
const FIXES_TO_TRUST = 5; // consecutive GPS fixes that must agree before the feeder is started or stopped, or the position moved
const HOME_RADIUS_KM = Number(config.awayKm) || 3.2; // about 2 miles: how near the home pin counts as at home, and how far the GPS must move before the position follows it
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

// tar1090's column of one-letter map buttons has more than a touchscreen needs. These are left out:
// T (all tracks; Settings > Map shows has it), K (track labels), M (select several), P (keep old positions), R (follow a random aircraft).
const HIDDEN_MAP_BUTTONS = ['T', 'K', 'M', 'P', 'R'];
function hideMapButtons(wc) {
  wc.insertCSS(`${HIDDEN_MAP_BUTTONS.map((id) => `#${id}.button`).join(', ')} { display: none !important; }`).catch(() => {});
}

// For the "Radar scope" map style: once the local map has loaded, the wireframe-and-sweep overlay
// is run inside it. The outline data is public-domain Natural Earth coastlines and borders.
function addRadarScope(wc) {
  if (display.mapStyle().id !== 'radar' || wc.getURL().startsWith('file:')) return;
  const unit = UNIT_METRES[config.distanceUnits] ? config.distanceUnits : 'nautical';
  const radarConfig = { rings: config.rangeRings || [], ringUnit: UNIT_LABEL[unit], metresPerUnit: UNIT_METRES[unit] };
  const outlines = fs.readFileSync(path.join(__dirname, 'outlines.json'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, 'radar-scope.js'), 'utf8');
  const places = fs.readFileSync(path.join(__dirname, 'places.json'), 'utf8');
  wc.executeJavaScript(`window.__radarOutlines = ${outlines}; window.__radarPlaces = ${places}; window.__radarConfig = ${JSON.stringify(radarConfig)};\n${script}`).catch(() => {});
}

// Settings decides which extras the local map shows. The map also keeps its own memory of some of
// them, which would otherwise bring back one that has been switched off; that memory is cleared
// and the map loaded once more.
function forgetMapExtras(wc) {
  const keys = display.mapForget();
  if (!keys.length || wc.getURL().startsWith('file:')) return;
  wc.executeJavaScript(`(() => { let had = false; for (const key of ${JSON.stringify(keys)}) { if (localStorage.getItem(key) !== null) { localStorage.removeItem(key); had = true; } } if (had) location.reload(); })()`).catch(() => {});
}

// True when the receiver is on this machine (not a stand-in map on the internet, as in development).
const RECEIVER_IS_HERE = Boolean(process.env.READSB_SET_LOCATION) || ['localhost', '127.0.0.1'].includes(new URL(config.localRadarUrl).hostname);
const tabs = {
  // With no position yet (a new device before a postcode or a GPS fix) the map has nowhere to centre, so a notice is shown instead.
  local: { url: config.localRadarUrl, notice: () => (RECEIVER_IS_HERE && !current ? 'nolocation.html' : null), onLoad: (wc) => { hideMapButtons(wc); forgetMapExtras(wc); addRadarScope(wc); } },
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
// "welcome" title and message in config.json. It stays until the screen is touched, and then does not
// come back by itself (the choice is kept with the other settings); Settings can show it again.
// `scripts/protect.sh enable --show-welcome` arms it again.
const welcomeText = () => ({ title: String((config.welcome || {}).title || ''), message: String((config.welcome || {}).message || '') });
function showWelcome() {
  const text = welcomeText();
  if (!(text.title || text.message) || welcomeView) return;
  hideKeyboard();
  welcomeView = new WebContentsView({ webPreferences: { preload: PRELOAD } });
  win.contentView.addChildView(welcomeView); // added last, so it sits above the tabs
  welcomeView.webContents.on('did-finish-load', () => welcomeView.webContents.setZoomFactor(ZOOM));
  welcomeView.webContents.loadFile(path.join(__dirname, 'welcome.html'));
  layout();
}
function showWelcomeOnce() {
  if (!display.get().welcomeShown) showWelcome();
}
ipcMain.handle('welcome:get', welcomeText);
ipcMain.on('welcome:show', showWelcome); // "View Christmas message" in Settings
ipcMain.on('welcome:done', () => {
  if (!welcomeView) return;
  win.contentView.removeChildView(welcomeView);
  welcomeView.webContents.close();
  welcomeView = null;
  display.update({ welcomeShown: true });
});

// True while a web tab is on a site other than its own (any address under flightradar24.com counts
// as Flightradar24, so its sign-in pages do not). Our own "not available" notice is not another site.
function isAway(tab) {
  let at, home;
  try { at = new URL(tab.view.webContents.getURL()); home = new URL(tab.url).hostname.replace(/^www\./, ''); } catch { return false; }
  return /^https?:$/.test(at.protocol) && at.hostname !== home && !at.hostname.endsWith(`.${home}`);
}
function reportAway(tab) {
  const name = Object.keys(tabs).find((key) => tabs[key] === tab);
  if (bar) bar.webContents.send('away', name, isAway(tab));
}

function createTab(tab) {
  // Our own pages get the app's bridge. Web pages get only the keyboard watcher, in their frames too
  // (a sign-in form is often inside one).
  const webPreferences = tab.file ? { preload: PRELOAD }
    : { preload: WEB_PRELOAD, nodeIntegrationInSubFrames: true, ...(tab.partition ? { partition: tab.partition } : {}) };
  tab.view = new WebContentsView({ webPreferences });
  const wc = tab.view.webContents;
  const name = Object.keys(tabs).find((key) => tabs[key] === tab);
  wc.on('did-finish-load', () => {
    if (!wc.getURL().startsWith('file:')) log.state(`tab:${name}`, 'tab', `${name} loaded`, sinceStart());
    wc.setZoomFactor(ZOOM); // zoom is per site, so set it on every load
    if (tab.onLoad) tab.onLoad(wc);
  });
  tab.load = () => {
    const file = tab.file || (tab.notice && tab.notice());
    return file ? wc.loadFile(path.join(__dirname, file)) : wc.loadURL(tab.url).catch(() => {}); // failures are handled by did-fail-load
  };
  wc.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument && typingInto === wc) hideKeyboard(); });
  // The tab bar offers a way back while a web tab is showing some other site (see tabbar.html).
  if (!tab.file) for (const event of ['did-navigate', 'did-navigate-in-page']) wc.on(event, () => reportAway(tab));
  // There is no way back from a popup on a kiosk, so open links in place instead.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  // If a site cannot load (receiver still starting, no network), show a notice and keep retrying.
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || url.startsWith('file:')) return; // -3 = navigation aborted
    log.state(`tab:${name}`, 'tab', `${name} could not load (${desc || code}); retrying every ${RETRY_MS / 1000} s`);
    wc.loadFile(path.join(__dirname, 'offline.html'));
    clearTimeout(tab.retry); // one retry chain per tab, however many loads failed
    tab.retry = setTimeout(tab.load, RETRY_MS);
  });
  wc.on('render-process-gone', (_e, details) => log('crash', `${name} page stopped: ${details.reason} (exit code ${details.exitCode})`));
  wc.on('unresponsive', () => log('error', `${name} page stopped responding`));
  wc.on('responsive', () => log('error', `${name} page is responding again`));
  if (tab === tabs.fr24 && BLOCK_ADVERTS) fr24.refuseOtherFrames(wc.session);
  tab.load();
  win.contentView.addChildView(tab.view);
}

// The FR24 feeder is registered at a fixed location, so it only runs while GPS shows the device is
// at home: it is started once several fixes in a row agree it is within awayKm of home, and stopped
// once they agree it is not. A single odd fix changes nothing, and losing GPS later changes nothing
// either (the device has not moved just because the signal dropped).
function controlFeedFromGps(position) {
  if (!home) return;
  const away = feed.distanceKm(home, position) > HOME_RADIUS_KM;
  if (away !== verdict.away) verdict = { away, count: 0 };
  if (++verdict.count < FIXES_TO_TRUST || away === feedPaused) return;
  feedPaused = away;
  log('feed', away ? 'GPS says away from home: stopping the Flightradar24 feeder' : 'GPS says at home: starting the Flightradar24 feeder');
  feed.setRunning(!away);
}

const freshGps = () => (gpsFix && Date.now() - gpsFixAt < GPS_FRESH_MS ? gpsFix : null);

function homeInfo() {
  const gpsNow = freshGps();
  return {
    home,
    postcode: onDevice.postcode || null,
    current,
    atHome: location.same(current, home),
    feedRequiresGps,
    hasGps: Boolean(gpsNow),
    distanceKm: current && gpsNow ? feed.distanceKm(current, gpsNow) : null, // from the position in use to the GPS
  };
}

// Tells the decoder where the receiver is. This restarts the decoder, so the map is empty for a few seconds.
function setReceiverLocation({ latitude, longitude }) {
  const command = process.env.READSB_SET_LOCATION; // dev stand-in
  const [file, args] = command
    ? [command, [String(latitude), String(longitude)]]
    : ['sudo', ['-n', 'readsb-set-location', String(latitude), String(longitude)]];
  return new Promise((resolve) => execFile(file, args, { timeout: 30000 }, (err) => resolve(!err)));
}

// Moves the receiver's own position (map centre and range rings) to the position in use, with a
// message over the local map while the decoder restarts. Resolves to whether the decoder took it.
const REPOSITION_NOTE = `(() => { if (document.getElementById('__repositioning')) return; const d = document.createElement('div'); d.id = '__repositioning'; d.textContent = 'Repositioning, locating aircraft…'; d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:rgba(11,22,34,.9);color:#e8eef5;font:600 28px system-ui,sans-serif'; document.documentElement.append(d); })()`;
let repositioning = null;
function reposition() {
  if (!RECEIVER_IS_HERE || !current) return Promise.resolve(false);
  repositioning ||= (async () => {
    let ok, to;
    do { // again if the position changed while the decoder was restarting
      to = current;
      tabs.local.view.webContents.executeJavaScript(REPOSITION_NOTE).catch(() => {});
      ok = await setReceiverLocation(to);
      log('location', `receiver ${ok ? 'moved' : 'could NOT be moved'} to ${to.latitude}, ${to.longitude}`);
      // Give the decoder time to come back and start writing aircraft again (up to half a minute).
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if ((await receiverStatus()).state === 'ok') break;
      }
    } while (to !== current);
    repositioning = null;
    tabs.local.load(); // the map reads the receiver's position when it loads; this also clears the message
    return ok;
  })();
  return repositioning;
}

// Protected storage forgets the decoder's settings at each restart, and a fresh install has none,
// so at start-up the decoder is brought into line with the position in use if it differs.
async function alignReceiver() {
  if (!RECEIVER_IS_HERE || !current) return;
  try {
    const receiver = await (await fetch(new URL('data/receiver.json', config.localRadarUrl), { signal: AbortSignal.timeout(3000) })).json();
    const there = location.valid({ latitude: receiver.lat, longitude: receiver.lon });
    if (there && feed.distanceKm(current, there) < 0.1) return;
  } catch {
    return void setTimeout(alignReceiver, 10000); // the decoder is not up yet
  }
  reposition();
}

// Puts a new position into use: remembered on the device, and the receiver moved to it.
function moveTo(position) {
  if (!position || location.same(position, current)) return Promise.resolve(true);
  current = position;
  log('location', `position in use is now ${position.latitude}, ${position.longitude} (${location.same(position, home) ? 'the home pin' : 'from the GPS'})`);
  saveOnDevice({ current });
  return reposition();
}

// Each GPS fix is put through the rule in location.js. The position only moves once several fixes
// in a row say it should, so one odd fix changes nothing.
let pendingMoves = 0;
function followGps(position) {
  const next = location.choose(home, current, position, HOME_RADIUS_KM);
  if (location.same(next, current)) return void (pendingMoves = 0);
  if (++pendingMoves < FIXES_TO_TRUST) return;
  pendingMoves = 0;
  moveTo(next);
}

// A new home pin. The feeder is decided again against it, and the position in use follows the
// rule straight away (this is a deliberate change, so there is no waiting for several fixes).
// The receiver is moved in the background; the map shows its own message while that happens.
function setHome(position, postcode) {
  const wasAtHome = !current || location.same(current, home);
  home = position;
  log('location', `home pin set ${postcode ? 'by postcode' : 'to the GPS position'}: ${position.latitude}, ${position.longitude}`);
  saveOnDevice({ home, postcode: postcode || null });
  feedPaused = null;
  verdict = { away: null, count: 0 };
  pendingMoves = 0;
  moveTo(location.choose(home, wasAtHome ? null : current, freshGps(), HOME_RADIUS_KM));
  return homeInfo();
}

// For after a house move, or with no Wi-Fi for a postcode: makes the current GPS position the home
// pin. The location registered with Flightradar24 is changed on their website; this brings the
// device into line with it, so the feeder runs at the new address and no longer at the old one.
function setHomeToGps() {
  const gpsNow = freshGps();
  if (!gpsNow) throw new Error('No GPS fix yet. Try again near a window.');
  return setHome(location.round(gpsNow), null);
}

async function setHomeToPostcode(text) {
  const { postcode, position } = await location.lookupPostcode(text);
  return setHome(position, postcode);
}

// Away from home (on holiday, say) the held position can be up to the radius from where the
// device has ended up. This takes the GPS position as it is now, without moving the home pin.
function useGpsNow() {
  const gpsNow = freshGps();
  if (!gpsNow) throw new Error('No GPS fix yet. Try again near a window.');
  if (home && feed.distanceKm(home, gpsNow) <= HOME_RADIUS_KM) throw new Error('This is at home, so the home position is used.');
  pendingMoves = 0;
  moveTo(location.round(gpsNow));
  return homeInfo();
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

// Gives both map pages a browser location: the position in use (see location.js). The browser has no other location source, so without this any page feature that
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
    if (!current) return;
    const here = { ...current, accuracy: 100 };
    for (const wc of pages) {
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach();
        wc.debugger.sendCommand('Emulation.setGeolocationOverride', here).catch(() => {});
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
  log.state('status:receiver', 'status', `receiver: ${receiver.state === 'ok' ? 'working' : 'no aircraft data'}`);
  log.state('status:feed', 'status', `Flightradar24 feeder: ${feeder.state}`);
  log.state('status:gps', 'status', `GPS: ${gpsState.state === 'ok' ? 'has a fix' : 'no fix'}`, sinceStart());
  log.state('status:wifi', 'status', `Wi-Fi: ${network.state === 'ok' ? `connected to ${network.name}` : network.state === 'off' ? 'not managed here' : 'not connected'}`);
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

// Whether the graphics chip is really being used, and anything in the engine that dies.
let gpuWas = '';
app.on('gpu-info-update', () => {
  const s = app.getGPUFeatureStatus();
  const now = `drawing ${s.gpu_compositing}, rasterization ${s.rasterization}, WebGL ${s.webgl}`;
  if (now !== gpuWas) log('gpu', gpuWas = now);
});
app.on('child-process-gone', (_e, details) => log('crash', `${details.type} process stopped: ${details.reason} (exit code ${details.exitCode})`));

// The Pi's own record of its power supply and heat. Under-voltage makes it slow itself right down,
// so this is the first thing to look at when the device feels sluggish. Not present off the Pi.
const POWER_FLAGS = [[0x1, 'UNDER-VOLTAGE NOW'], [0x2, 'speed capped now'], [0x4, 'slowed down now'], [0x8, 'running hot now'],
  [0x10000, 'under-voltage earlier'], [0x20000, 'speed capped earlier'], [0x40000, 'slowed down earlier'], [0x80000, 'ran hot earlier']];
function watchPower() {
  execFile('vcgencmd', ['get_throttled'], { timeout: 5000 }, (err, out) => {
    if (err && err.code === 'ENOENT') return; // not a Pi
    const value = err ? NaN : parseInt(String(out).split('=')[1], 16);
    if (Number.isFinite(value)) {
      const flags = POWER_FLAGS.filter(([bit]) => value & bit).map(([, name]) => name);
      log.state('power', 'power', flags.length ? `power supply problem: ${flags.join(', ')}` : 'power supply good');
    }
    setTimeout(watchPower, 60000);
  });
}

app.whenReady().then(() => {
  // The app normally runs about ten processes. Many more means web pages are filling up with
  // frames again (adverts that fr24.js does not know about), which is what makes it sluggish.
  setInterval(() => {
    const count = app.getAppMetrics().length;
    log.state('processes', 'load', count > 15 ? 'many processes' : 'normal number of processes', `(${count})`);
  }, 60000);
  const restored = storageRestored();
  if (restored) log('storage', restored);
  watchPower();
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
    for (const tab of Object.values(tabs)) if (tab.view && !tab.file) reportAway(tab);
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
    followGps(position);
  });
  alignReceiver();
  // Nothing else starts the feeder at boot (see scripts/install-fr24.sh), so when it is not
  // waiting for GPS it is started here.
  log('feed', feedWaitsForGps() ? 'Flightradar24 feeder waits until the GPS shows the device is at home' : 'starting the Flightradar24 feeder');
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
  // back to that tab's start page (a button in Settings).
  ipcMain.on('tab:home', (_e, name) => {
    if (!tabs[name] || tabs[name].file) return;
    tabs[name].load();
    select(name);
  });
  // And the stronger version for Flightradar24: forget the sign-in and everything else the site
  // has stored, then start again from its front page.
  ipcMain.on('fr24:signOut', async () => {
    log('settings', 'Flightradar24: signed out and site data cleared');
    await session.fromPartition(tabs.fr24.partition).clearStorageData().catch(() => {});
    tabs.fr24.load();
    select('fr24');
  });
  // Errors come back as { error } so the page can show the message as plain text.
  const reply = (work) => work.then((result) => ({ result }), (err) => ({ error: err.message }));
  ipcMain.handle('wifi:list', () => reply(wifi.list()));
  const wifiChanged = () => { requestBackup('wifi'); return sendStatus(); };
  // The password is never logged.
  const noted = (what, work) => work.then((result) => { log('wifi', what); return result; }, (err) => { log('wifi', `${what}: FAILED: ${err.message}`); throw err; });
  ipcMain.handle('wifi:connect', (_e, ssid, password) => reply(noted(`join ${ssid}`, wifi.connect(ssid, password)).then(wifiChanged)));
  ipcMain.handle('wifi:forget', (_e, ssid) => reply(noted(`forget ${ssid}`, wifi.forget(ssid)).then(wifiChanged)));
  ipcMain.handle('log:read', () => log.read());
  ipcMain.handle('update:info', () => update.info());
  ipcMain.handle('update:check', () => reply(update.check().then(
    (found) => { log('update', found.behind ? `${found.behind} change${found.behind === 1 ? '' : 's'} available; newest: ${found.latest}` : `checked: up to date (${found.current})`); return found; },
    (err) => { log('update', `check FAILED: ${err.message}`); throw err; })));
  ipcMain.handle('update:start', () => reply(Promise.resolve().then(() => { log('update', 'update started from Settings; the app will be restarted by it'); update.start(); })));
  ipcMain.handle('home:get', () => homeInfo());
  ipcMain.handle('home:set', () => reply(Promise.resolve().then(setHomeToGps)));
  ipcMain.handle('home:postcode', (_e, text) => reply(setHomeToPostcode(text).catch((err) => { log('location', `postcode lookup failed: ${err.message}`); throw err; })));
  ipcMain.handle('home:useGps', () => reply(Promise.resolve().then(useGpsNow)));
  ipcMain.handle('home:feedWait', (_e, value) => setFeedRequiresGps(value));
  ipcMain.handle('display:get', () => ({ ...display.get(), storageRestored: storageRestored() }));
  ipcMain.handle('display:set', (_e, patch) => {
    const before = localUrl();
    const result = display.update(patch || {});
    log('settings', 'changed:', patch || {});
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
