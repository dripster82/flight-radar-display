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
let settings = { brightness: 100, nightDim: true, theme: 'navy', mapStyle: 'standard' };

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
  return { available: Boolean(backlight()), ...settings, night: night || null, themes: THEMES, mapStyles: MAP_STYLES };
}

function update(patch) {
  if (Number.isFinite(patch.brightness)) settings.brightness = Math.min(100, Math.max(MIN_PERCENT, Math.round(patch.brightness)));
  if (typeof patch.nightDim === 'boolean') settings.nightDim = patch.nightDim;
  if (THEMES.some((theme) => theme.id === patch.theme)) settings.theme = patch.theme;
  if (MAP_STYLES.some((style) => style.id === patch.mapStyle)) settings.mapStyle = patch.mapStyle;
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings)); } catch { /* still applies for this session */ }
  apply();
  return get();
}

function init(config, dataDir) {
  settingsFile = path.join(dataDir, 'display.json');
  night = config.night;
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { /* first run */ }
  if (!THEMES.some((theme) => theme.id === settings.theme)) settings.theme = 'navy';
  if (!MAP_STYLES.some((style) => style.id === settings.mapStyle)) settings.mapStyle = 'standard';
  apply();
  setInterval(apply, 60000); // picks up the start and end of the night hours
}

const mapStyle = () => MAP_STYLES.find((style) => style.id === settings.mapStyle);

module.exports = { init, get, update, isNight, mapStyle };
