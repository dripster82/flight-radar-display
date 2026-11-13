// node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const { choose } = require('../src/location');

const R = 3.2; // km, about 2 miles
const pin = { latitude: 54.0, longitude: -1.0 };
const north = (km, from = pin) => ({ latitude: from.latitude + km / 111.19, longitude: from.longitude });

test('no GPS: the position in use stays, else the pin, else nothing', () => {
  assert.equal(choose(null, null, null, R), null);
  assert.equal(choose(pin, null, null, R), pin);
  const held = north(50);
  assert.equal(choose(pin, held, null, R), held);
});

test('GPS inside the radius of the pin gives the pin exactly', () => {
  assert.equal(choose(pin, null, north(1), R), pin);
  assert.equal(choose(pin, north(50), north(3), R), pin); // coming home snaps back
});

test('GPS outside the radius gives the GPS position', () => {
  const got = choose(pin, pin, north(4), R);
  assert.ok(Math.abs(got.latitude - north(4).latitude) < 1e-5);
});

test('away: held still until the GPS is more than the radius from the held position', () => {
  const held = north(50);
  assert.equal(choose(pin, held, north(3, held), R), held);
  const moved = choose(pin, held, north(4, held), R);
  assert.notDeepEqual(moved, held);
});

test('no pin: the first fix is taken, then held', () => {
  const first = choose(null, null, north(0), R);
  assert.deepEqual(first, pin);
  assert.equal(choose(null, first, north(2), R), first);
});
