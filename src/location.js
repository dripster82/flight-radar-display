// Which position the display works from (map centre, range rings, "my location").
//
// There are two sources: the home pin (set in Settings from a postcode, or from the GPS) and the
// GPS stick. The position in use only ever changes in jumps, never continuously:
//   - GPS within the radius of the home pin: the pin itself, so nothing drifts at home.
//   - GPS further away: the GPS position, held still until the GPS has moved more than the radius
//     from that held position, when the new GPS position is taken and held instead.
//   - No GPS fix: whatever was in use last, or the pin when there is nothing yet.
const { distanceKm } = require('./feed');

const round = ({ latitude, longitude }) => ({ latitude: Number(latitude.toFixed(5)), longitude: Number(longitude.toFixed(5)) });
const same = (a, b) => Boolean(a && b) && a.latitude === b.latitude && a.longitude === b.longitude;
const valid = (p) => (p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) ? { latitude: p.latitude, longitude: p.longitude } : null);

// pin: the home pin or null. current: the position in use now, or null. gps: the latest fix, or null.
function choose(pin, current, gps, radiusKm) {
  if (!gps) return current || pin || null;
  if (pin && distanceKm(pin, gps) <= radiusKm) return pin;
  if (current && !same(current, pin) && distanceKm(current, gps) <= radiusKm) return current;
  return round(gps);
}

// UK postcode to coordinates, from the free postcodes.io service. Needs the internet once; the
// answer is then kept on the device.
async function lookupPostcode(text) {
  const postcode = String(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (postcode.length < 5 || postcode.length > 7) throw new Error('That does not look like a UK postcode.');
  let res;
  try {
    res = await fetch(`${process.env.POSTCODE_URL || 'https://api.postcodes.io/postcodes/'}${postcode}`, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error('Could not reach the postcode service. Check the Wi-Fi.');
  }
  if (res.status === 404) throw new Error('Postcode not found.');
  const found = valid((await res.json().catch(() => ({}))).result);
  if (!res.ok || !found) throw new Error('The postcode service gave no position.');
  return { postcode: `${postcode.slice(0, -3)} ${postcode.slice(-3)}`, position: round(found) };
}

module.exports = { choose, lookupPostcode, round, same, valid };
