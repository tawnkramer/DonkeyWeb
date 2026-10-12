import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

// Recording sessions only apply to worlds with signals. Elsewhere the
// original throttle > 0 gate is kept (see test/recording.test.js).
let page, teardown;

before(async () => {
  ({ page, teardown } = await setupSimPage());
  await page.evaluate(() => window.__sim.setWorld('city'));
  assert.equal(await page.evaluate(() => window.__sim.hasSignals()), true);
});
after(() => teardown());

// The city world's traffic lights are only learnable if stopping is IN the
// dataset. The old gate (`input.throttle > 0`) dropped every frame of a
// stop, so the tub could never contain a zero-throttle label and a cloned
// model had no example of stopping to learn from. See updateSession() in
// sim/main.js.
test('keeps recording through a stop, capturing zero-throttle frames', async () => {
  await page.evaluate(() => { __sim.input.steer = 0; __sim.input.throttle = 0.6; });
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
