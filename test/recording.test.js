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

// The city world's traffic lights are only learnable if stopping is IN the
// dataset. The old gate (`input.throttle > 0`) dropped every frame of a
// stop, so the tub could never contain a zero-throttle label and a cloned
// model had no example of stopping to learn from. See updateSession() in
// sim/main.js.
test('keeps recording through a stop, capturing zero-throttle frames', async () => {
  await page.evaluate(() => { __sim.input.throttle = 0.6; });
  await waitFor(page, () => window.__sim.V.speed > 2, { message: 'car never got moving' });

  // Lift off and let it coast to a standstill.
  await page.evaluate(() => { __sim.input.throttle = 0; });
  await waitFor(page, () => window.__sim.V.speed === 0, { message: 'car never came to rest' });

  const atRest = await page.evaluate(() => window.__sim.tub.frames.length);
  assert.equal(await page.evaluate(() => window.__sim.sessionOpen), true,
    'session closed as soon as the driver lifted off');

  // Frames must keep landing while stopped -- this is the "waiting at a
  // red light" data.
  await waitFor(page, (n) => window.__sim.tub.frames.length > n, {
    args: [atRest],
    message: 'no frames recorded while stopped -- a stop cannot be learned from this tub',
  });

  const zeroThrottle = await page.evaluate(() =>
    window.__sim.tub.frames.filter((f) => f.throttle === 0).length);
  assert.ok(zeroThrottle > 0, 'tub contains no zero-throttle frames');
});

test('closes the session once the car is left parked', async () => {
  // SESSION_IDLE_S is 4s; allow margin for the sandbox's slow frames.
  await waitFor(page, () => window.__sim.sessionOpen === false, {
    timeout: 15000,
    message: 'session never closed while parked -- a forgotten car would flood the tub',
  });

  const settled = await page.evaluate(() => window.__sim.tub.frames.length);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await page.evaluate(() => window.__sim.tub.frames.length), settled,
    'frames kept accumulating after the session closed');
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
