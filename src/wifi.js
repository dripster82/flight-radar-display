// Wi-Fi control through NetworkManager's nmcli (what Raspberry Pi OS uses).
// Networks joined here are saved by NetworkManager and rejoined on boot.
const { execFile } = require('node:child_process');

const NMCLI = process.env.NMCLI || 'nmcli';

function nmcli(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(NMCLI, args, { timeout }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(new Error('Wi-Fi settings only work on the device itself.'));
      if (err.killed) return reject(new Error('That took too long. Please try again.'));
      reject(new Error((stderr || err.message).trim().replace(/^Error:\s*/, '')));
    });
  });
}

// nmcli's terse output separates fields with ':' and backslash-escapes any ':' or '\' inside a value.
// The last field keeps everything left over, so an SSID can contain anything.
function splitTerse(line, fieldCount) {
  const fields = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) current += line[++i];
    else if (ch === ':' && fields.length < fieldCount - 1) { fields.push(current); current = ''; }
    else current += ch;
  }
  fields.push(current);
  return fields;
}

function parseList(output) {
  const strongest = new Map(); // one row per network name; a network often has several access points
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [inUse, signal, security, ssid] = splitTerse(line, 4);
    if (!ssid) continue; // hidden network
    const network = { ssid, signal: Number(signal) || 0, secured: Boolean(security && security !== '--'), connected: inUse === '*' };
    const seen = strongest.get(ssid);
    if (!seen) strongest.set(ssid, network);
    else {
      seen.connected = seen.connected || network.connected;
      seen.signal = Math.max(seen.signal, network.signal);
    }
  }
  return [...strongest.values()].sort((a, b) => b.connected - a.connected || b.signal - a.signal);
}

async function list() {
  return parseList(await nmcli(['-t', '-f', 'IN-USE,SIGNAL,SECURITY,SSID', 'device', 'wifi', 'list', '--rescan', 'auto'], 30000));
}

async function connect(ssid, password) {
  const args = ['device', 'wifi', 'connect', String(ssid)];
  if (password) args.push('password', String(password));
  await nmcli(args, 60000);
}

module.exports = { list, connect, parseList };
