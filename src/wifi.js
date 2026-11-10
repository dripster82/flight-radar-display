// Wi-Fi control through NetworkManager's nmcli (what Raspberry Pi OS uses).
// Networks joined here are saved by NetworkManager and rejoined on boot.
const { execFile } = require('node:child_process');

const NMCLI = process.env.NMCLI || 'nmcli';

function nmcli(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(NMCLI, args, { timeout }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(Object.assign(new Error('Wi-Fi settings only work on the device itself.'), { missing: true }));
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

// Names of the Wi-Fi networks NetworkManager has a saved password for.
// A network joined from this screen is saved under its own name.
async function savedNames() {
  const output = await nmcli(['-t', '-f', 'TYPE,NAME', 'connection', 'show'], 15000);
  const names = new Set();
  for (const line of output.split('\n')) {
    const [type, name] = splitTerse(line, 2);
    if (type === '802-11-wireless' && name) names.add(name);
  }
  return names;
}

async function list() {
  const [output, saved] = await Promise.all([
    nmcli(['-t', '-f', 'IN-USE,SIGNAL,SECURITY,SSID', 'device', 'wifi', 'list', '--rescan', 'auto'], 30000),
    savedNames(),
  ]);
  return parseList(output).map((network) => ({ ...network, saved: saved.has(network.ssid) }));
}

async function connect(ssid, password) {
  ssid = String(ssid);
  const wasSaved = (await savedNames()).has(ssid);
  try {
    if (wasSaved && !password) await nmcli(['connection', 'up', 'id', ssid], 60000);
    else await nmcli(['device', 'wifi', 'connect', ssid, ...(password ? ['password', String(password)] : [])], 60000);
  } catch (err) {
    // A failed first attempt (usually a wrong password) leaves a broken saved entry behind; remove it
    // so the network is not shown as saved and the next attempt starts clean.
    if (!wasSaved) await nmcli(['connection', 'delete', 'id', ssid], 15000).catch(() => {});
    throw err;
  }
}

async function forget(ssid) {
  await nmcli(['connection', 'delete', 'id', String(ssid)], 15000);
}

// For the status light: 'ok' with the network name, 'bad' when not connected, 'off' where there is no nmcli.
async function status() {
  try {
    const output = await nmcli(['-t', '-f', 'TYPE,STATE,CONNECTION', 'device'], 10000);
    for (const line of output.split('\n')) {
      const [type, state, name] = splitTerse(line, 3);
      if (type === 'wifi' && state === 'connected') return { state: 'ok', name };
    }
    return { state: 'bad' };
  } catch (err) {
    return { state: err.missing ? 'off' : 'bad' };
  }
}

module.exports = { list, connect, forget, status, parseList };
