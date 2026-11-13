// Updates from the device itself (Settings > Updates), so no SSH is needed.
// Checking asks GitHub what is new; updating runs scripts/update.sh, which fetches and installs
// the new version and restarts the app (or, with power-cut protection on, restarts the device
// twice: once to make it writable, once to protect it again). See that script for the sequence.
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const COMMAND = process.env.UPDATE_CMD || path.join(REPO, 'scripts', 'update.sh'); // UPDATE_CMD: dev stand-in
// update.sh keeps its own record of the last update here (see that script).
const RECORD = process.env.UPDATE_RECORD || ['/boot/firmware', '/var/lib'].map((dir) => path.join(dir, 'flight-radar-update.log')).find((file) => fs.existsSync(file));
// Only the device can install an update; on a development machine the check still works.
const canUpdate = Boolean(process.env.UPDATE_CMD) || process.platform === 'linux';

const git = (args, timeout = 15000) => new Promise((resolve, reject) => {
  execFile('git', ['-C', REPO, ...args], { timeout }, (err, out) => (err ? reject(err) : resolve(out.trim())));
});

async function info() {
  let lastUpdate = null;
  try { lastUpdate = fs.readFileSync(RECORD, 'utf8').trim().split('\n').pop() || null; } catch { /* never updated this way */ }
  return { current: await git(['log', '-1', '--format=%h, %cs']).catch(() => 'unknown'), canUpdate, lastUpdate };
}

// How many changes GitHub has that this device does not, and what the newest one is.
async function check() {
  try { await git(['fetch', '--quiet'], 60000); } catch { throw new Error('Could not reach GitHub. Check the Wi-Fi.'); }
  const behind = Number(await git(['rev-list', '--count', 'HEAD..@{upstream}']));
  return { ...(await info()), behind, latest: behind ? await git(['log', '-1', '--format=%s', '@{upstream}']) : null };
}

// Started on its own so it carries on when it stops the app.
function start() {
  if (!canUpdate) throw new Error('Updates can only be installed on the device itself.');
  spawn(COMMAND, [], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { info, check, start };
