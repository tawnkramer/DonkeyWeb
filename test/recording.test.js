import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

let page, teardown;

before(async () => { ({ page, teardown } = await setupSimPage()); });
after(() => teardown());

test('records while driving forward and on-track', async () => {
  assert.equal(await page.evaluate(() => window.__sim.tub.frames.length), 0);

  await page.evaluate(() => { __sim.input.throttle = 0.6; });
  await waitFor(page, () => window.__sim.tub.frames.length > 0, {
    message: 'no frames recorded while driving forward and on-track',
  });

  const frame = await page.evaluate(() => __sim.tub.frames[0]);
  assert.equal(typeof frame.steer, 'number');
  assert.equal(frame.throttle, 0.6);
});

// The default world has no signals, so it keeps the original gate:
// recording is on exactly while the throttle is > 0. Signal worlds record
// through stops instead -- see test/sessions.test.js.
test('stops recording as soon as the throttle is released', async () => {
  await page.evaluate(() => { __sim.input.throttle = 0.6; });
  await waitFor(page, () => window.__sim.V.speed > 2, { message: 'car never got moving' });

  await page.evaluate(() => { __sim.input.throttle = 0; });
  await waitFor(page, () => window.__sim.sessionOpen === false, {
    message: 'recording stayed on after lifting off in a world without signals',
  });

  const settled = await page.evaluate(() => window.__sim.tub.frames.length);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(await page.evaluate(() => window.__sim.tub.frames.length), settled,
    'frames kept accumulating with the throttle released');
  const zeroThrottle = await page.evaluate(() =>
    window.__sim.tub.frames.filter((f) => f.throttle <= 0).length);
  assert.equal(zeroThrottle, 0, 'recorded zero-throttle frames in a world without signals');

  // Leave the car moving so the off-track test below has fresh frames.
  await page.evaluate(() => { __sim.input.throttle = 0.6; });
  await waitFor(page, (n) => window.__sim.tub.frames.length > n, {
    args: [settled],
    message: 'recording did not resume when the throttle was reapplied',
  });
});

test('going off-track trims the last 3s, resets the car to the track, and zeroes throttle', async () => {
  const beforeCount = await page.evaluate(() => __sim.tub.frames.length);
  assert.ok(beforeCount > 0, 'expected frames left over from the previous test to trim');

  await page.evaluate(() => { __sim.V.x += 60; __sim.V.z += 60; });
  // offTrack itself flips back to false within the same physics tick as
  // the reset (car.js clears it right after resetCar()), so it's not a
  // reliable thing to poll for -- input.throttle getting zeroed is the
  // signal that stays true once the reset has actually happened.
  await waitFor(page, () => window.__sim.input.throttle === 0, {
    message: 'off-track reset never fired',
  });

  const afterCount = await page.evaluate(() => __sim.tub.frames.length);
  assert.ok(afterCount < beforeCount, `expected trimming to reduce frame count (was ${beforeCount}, now ${afterCount})`);
  assert.equal(await page.evaluate(() => __sim.cte), 0);
  assert.equal(await page.evaluate(() => __sim.V.speed), 0);
});
