// Screen brightness: a level chosen on the settings screen, optionally dimmed during night hours.
// The chosen level and the night switch are remembered in the app's data folder.
const fs = require('node:fs');
const path = require('node:path');

const BACKLIGHT_ROOT = process.env.BACKLIGHT_DIR || '/sys/class/backlight';
const MIN_PERCENT = 5; // never fully dark, or the screen could not be used to turn it back up

let settingsFile, night;
// Colour themes; the ids match the [data-theme] blocks in theme.css.
const THEMES = [
  { id: 'navy', name: 'Navy' },
  { id: 'graphite', name: 'Graphite' },
  { id: 'forest', name: 'Forest' },
  { id: 'day', name: 'Day' },
  { id: 'amber', name: 'Amber' },
];
// Looks for the local map. baseMap is the tar1090 map layer to show; 'radar' also gets the
// wireframe and sweep drawn over it (see radar-scope.js).
const MAP_STYLES = [
  { id: 'standard', name: 'Standard', baseMap: 'osm' },
  { id: 'dark', name: 'Dark', baseMap: 'OpenFreeMapDark' },
  { id: 'satellite', name: 'Satellite', baseMap: 'esri' },
  { id: 'radar', name: 'Radar scope', baseMap: 'osm', extra: '&altitudeChart=0' }, // the colour bar's dark text is unreadable on black
];
// Extras the local map can show, each switched on or off in Settings. `query` is what tar1090 is
// asked for in its address (see its README-query.md).
const MAP_OPTIONS = [
  // The map remembers labels being on by itself (`remembered`), so switching them off has to clear that too.
  { id: 'labels', name: 'Labels', query: 'enableLabels', remembered: 'enableLabels' }, // callsign beside each aircraft
  { id: 'trails', name: 'Trails', query: 'allTracks' },                       // the path each aircraft has flown
  { id: 'large', name: 'Larger aircraft', query: 'iconScale=1.6&labelScale=1.3' },
];
let settings = { brightness: 100, nightDim: true, theme: 'navy', mapStyle: 'radar', mapOptions: {}, welcomeShown: false };

function backlight() {
  try {
    const [name] = fs.readdirSync(BACKLIGHT_ROOT);
    return name ? path.join(BACKLIGHT_ROOT, name) : null;
  } catch {
    return null; // no controllable backlight (for example on a development machine)
  }
}

// from/to are "HH:MM"; a range like 22:00-07:00 wraps past midnight.
function isNight(date, from, to) {
  const now = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

function apply() {
  const dir = backlight();
  if (!dir) return;
  const dimmed = settings.nightDim && night && isNight(new Date(), night.from, night.to);
  const percent = dimmed ? Math.min(settings.brightness, night.brightness) : settings.brightness;
  try {
    const max = Number(fs.readFileSync(path.join(dir, 'max_brightness'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'brightness'), String(Math.max(1, Math.round((max * percent) / 100))));
  } catch { /* not permitted or unplugged; the next tick tries again */ }
}

function get() {
  return { available: Boolean(backlight()), ...settings, night: night || null, themes: THEMES, mapStyles: MAP_STYLES, mapOptionList: MAP_OPTIONS };
}

function update(patch) {
  if (Number.isFinite(patch.brightness)) settings.brightness = Math.min(100, Math.max(MIN_PERCENT, Math.round(patch.brightness)));
  if (typeof patch.nightDim === 'boolean') settings.nightDim = patch.nightDim;
  if (patch.welcomeShown === true) settings.welcomeShown = true; // set once the welcome message has been dismissed
  if (THEMES.some((theme) => theme.id === patch.theme)) settings.theme = patch.theme;
  if (MAP_STYLES.some((style) => style.id === patch.mapStyle)) settings.mapStyle = patch.mapStyle;
  for (const { id } of MAP_OPTIONS) {
    if (patch.mapOptions && typeof patch.mapOptions[id] === 'boolean') settings.mapOptions = { ...settings.mapOptions, [id]: patch.mapOptions[id] };
  }
  try {
    // New file, then swapped in: a power cut leaves the old settings or the new ones, never half a file.
    fs.writeFileSync(`${settingsFile}.tmp`, JSON.stringify(settings));
    fs.renameSync(`${settingsFile}.tmp`, settingsFile);
  } catch { /* still applies for this session */ }
  apply();
  return get();
}

function init(config, dataDir) {
  settingsFile = path.join(dataDir, 'display.json');
  night = config.night;
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { /* first run */ }
  if (!THEMES.some((theme) => theme.id === settings.theme)) settings.theme = 'navy';
  if (!MAP_STYLES.some((style) => style.id === settings.mapStyle)) settings.mapStyle = 'radar';
  if (!settings.mapOptions || typeof settings.mapOptions !== 'object') settings.mapOptions = {};
  apply();
  setInterval(apply, 60000); // picks up the start and end of the night hours
}

const mapStyle = () => MAP_STYLES.find((style) => style.id === settings.mapStyle);
// What to add to the local map's address for the chosen style and the extras switched on.
const mapQuery = () => [`baseMap=${mapStyle().baseMap}${mapStyle().extra || ''}`,
  ...MAP_OPTIONS.filter((option) => settings.mapOptions[option.id]).map((option) => option.query)].join('&');
// What the map itself may still remember as switched on, for extras that are switched off here.
const mapForget = () => MAP_OPTIONS.filter((option) => option.remembered && !settings.mapOptions[option.id]).map((option) => option.remembered);

module.exports = { init, get, update, isNight, mapStyle, mapQuery, mapForget };
