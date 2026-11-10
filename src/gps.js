// Reads position fixes from gpsd (the GPS service on the Pi) over its local JSON socket.
// Keeps reconnecting, so it does not matter if gpsd starts later or the GPS is unplugged.
const net = require('node:net');

const PORT = Number(process.env.GPSD_PORT) || 2947;
const RECONNECT_MS = 10000;

function watch(onFix) {
  let buffer = '';
  const socket = net.connect(PORT, '127.0.0.1');
  socket.setEncoding('utf8');
  socket.on('connect', () => socket.write('?WATCH={"enable":true,"json":true}\n'));
  socket.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let report;
      try { report = JSON.parse(line); } catch { continue; }
      // TPV = time/position/velocity; mode 2 or 3 means there is a real fix.
      if (report.class === 'TPV' && report.mode >= 2 && Number.isFinite(report.lat) && Number.isFinite(report.lon)) {
        onFix({ latitude: report.lat, longitude: report.lon, accuracy: Number.isFinite(report.eph) ? report.eph : 50 });
      }
    }
  });
  socket.on('error', () => {}); // 'close' follows and schedules the reconnect
  socket.on('close', () => setTimeout(() => watch(onFix), RECONNECT_MS));
}

module.exports = { watch };
