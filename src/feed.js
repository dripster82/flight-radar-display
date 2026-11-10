// The Flightradar24 feeder (fr24feed): its status, and stopping it while the device is away from home.
// The feeder is registered at a fixed location, so it should not upload from somewhere else.
const { execFile } = require('node:child_process');

const MONITOR_URL = process.env.FR24_MONITOR_URL || 'http://127.0.0.1:8754/monitor.json'; // fr24feed's own status page
const CONTROL = process.env.FEED_CONTROL; // dev stand-in for systemctl

// Starts or stops the service. Resolves to whether the command succeeded; it fails harmlessly
// when the feeder is not installed yet.
function setRunning(running) {
  const action = running ? 'start' : 'stop';
  const [command, args] = CONTROL ? [CONTROL, [action]] : ['sudo', ['-n', 'systemctl', action, 'fr24feed']];
  return new Promise((resolve) => execFile(command, args, { timeout: 20000 }, (err) => resolve(!err)));
}

// 'ok' when uploading, 'bad' when running but not connected, 'off' when the feeder is not running at all.
async function status() {
  try {
    const res = await fetch(MONITOR_URL, { signal: AbortSignal.timeout(3000) });
    const monitor = await res.json();
    return { state: monitor.feed_status === 'connected' ? 'ok' : 'bad' };
  } catch {
    return { state: 'off' };
  }
}

function distanceKm(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

module.exports = { setRunning, status, distanceKm };
