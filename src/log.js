// The diagnostic log: what started, what changed and what went wrong, one line each, so a
// problem can be looked into afterwards. Read it on the device (Settings > View log) or over SSH:
//   flight-radar.log        today so far (or since the last start, if the clock has since moved)
//   flight-radar.1.log      the file before that, and so on up to flight-radar.7.log
// It cannot grow without limit: a new file is started when the date changes or the file reaches
// MAX_BYTES, and only KEEP older files are kept, so the whole log stays under about 2 MB.
// Each line: date, time, a short kind (start, tab, gpu, power, ...), then the message.
// Never put a Wi-Fi password or anything else secret in a message.
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'flight-radar';
const KEEP = 7;
const MAX_BYTES = 256 * 1024;

let dir = null, file = null, day = null, size = 0;
let lastLine = null, repeats = 0; // for folding a run of identical lines into one
const states = new Map();

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeOf = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const older = (n) => path.join(dir, `${NAME}.${n}.log`);

function init(folder) {
  try {
    fs.mkdirSync(folder, { recursive: true });
    dir = folder;
    file = path.join(dir, `${NAME}.log`);
    try { const info = fs.statSync(file); size = info.size; day = dayOf(info.mtime); } catch { size = 0; day = null; }
  } catch {
    file = null; // nowhere to write: the app carries on without a log
  }
  return file;
}

function rotate() {
  for (let n = KEEP - 1; n >= 1; n--) { try { fs.renameSync(older(n), older(n + 1)); } catch { /* no such file */ } }
  try { fs.renameSync(file, older(1)); } catch { /* nothing to move */ }
  size = 0;
}

function append(now, kind, text) {
  const line = `${dayOf(now)} ${timeOf(now)} ${kind.padEnd(8)} ${text}\n`;
  if (size && (dayOf(now) !== day || size + line.length > MAX_BYTES)) rotate();
  fs.appendFileSync(file, line);
  size += Buffer.byteLength(line);
  day = dayOf(now);
}

function text(parts) {
  return parts.map((part) => (part instanceof Error ? part.stack || part.message : typeof part === 'string' ? part : JSON.stringify(part)))
    .join(' ').replace(/\s*\n\s*/g, ' | ').slice(0, 1000);
}

// log('kind', 'message', ...more). Extra parts are joined with spaces; errors and objects are written out.
function log(kind, ...parts) {
  if (!file) return;
  const now = new Date();
  const message = text(parts);
  try {
    if (`${kind} ${message}` === lastLine) return void repeats++;
    if (repeats) append(now, 'log', `the line before this was repeated ${repeats} more time${repeats === 1 ? '' : 's'}`);
    lastLine = `${kind} ${message}`; repeats = 0;
    append(now, kind, message);
  } catch { /* a full or missing log folder must never stop the app */ }
}

// For something checked over and over (a status light, a tab that keeps failing): written only
// when `value` differs from the last one given for `key`. `detail` is added but not compared.
log.state = (key, kind, value, detail = '') => {
  if (states.get(key) === value) return false;
  states.set(key, value);
  log(kind, detail ? `${value} ${detail}` : value);
  return true;
};

// The most recent lines, newest first, reaching back into older files as needed.
log.read = (count = 300) => {
  if (!file) return [];
  const lines = [];
  for (const from of [file, ...Array.from({ length: KEEP }, (_, i) => older(i + 1))]) {
    let content;
    try { content = fs.readFileSync(from, 'utf8'); } catch { continue; }
    lines.push(...content.split('\n').filter(Boolean).reverse());
    if (lines.length >= count) break;
  }
  return lines.slice(0, count);
};

log.init = init;
log.folder = () => dir;
module.exports = log;
