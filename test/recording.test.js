import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

let page, teardown;

before(async () => { ({ page, teardown } = await setupSimPage()); });
after(() => teardown());

test('records only while throttle > 0 and on-track', async () => {
  assert.equal(await page.evaluate(() => window.__sim.tub.frames.length), 0);

  await page.evaluate(() => { __sim.input.throttle = 0.6; });
  await waitFor(page, () => window.__sim.tub.frames.length > 0, {
    message: 'no frames recorded while driving forward and on-track',
  });

  const frame = await page.evaluate(() => __sim.tub.frames[0]);
  assert.equal(typeof frame.steer, 'number');
  assert.equal(frame.throttle, 0.6);
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
