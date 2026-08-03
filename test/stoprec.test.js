import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

let ctx, page;

before(async () => {
  ctx = await setupSimPage();
  page = ctx.page;
});

after(async () => {
  await ctx.teardown();
});

const visible = () => page.evaluate(() => {
  const b = document.getElementById('stopRecBtn');
  return getComputedStyle(b).display !== 'none';
});

// Puts the car back on the line and drives. Tests must not inherit the
// previous test's driving state: with steer held at 0 the car wanders off
// this world's curve within a few seconds, and the off-track reset zeroes
// the throttle -- which silently invalidates any later assertion about
// what the throttle is doing.
async function startTake() {
  await page.evaluate(() => {
    window.__sim.resetCarToStart();
    window.__sim.input.steer = 0;
    window.__sim.input.throttle = 0.6;
  });
  await waitFor(page, () => window.__sim.sessionOpen === true, {
    message: 'session never opened after driving off',
  });
}

test('the stop button is hidden until recording starts', async () => {
  assert.equal(await visible(), false, 'stop button is showing while idle');
});

test('it appears once frames are landing', async () => {
  await startTake();
  await waitFor(page, () => window.__sim.tub.frames.length > 0, {
    message: 'never started recording',
  });
  assert.equal(await visible(), true, 'stop button stayed hidden while recording');
});

test('clicking it ends the take even with the throttle still held', async () => {
  await startTake();
  await waitFor(page, () => {
    const b = document.getElementById('stopRecBtn');
    return getComputedStyle(b).display !== 'none';
  }, { message: 'stop button never appeared' });

  // The throttle is deliberately left ON. A naive implementation reopens
  // the session on the very next frame and the button does nothing.
  // Asserted as "still under power" rather than exactly 0.6: the car is
  // driving, and if it wanders off this world's curve the off-track reset
  // legitimately rewrites the throttle. That would invalidate the test's
  // premise, so it's checked -- but the exact value is not the point.
  const held = await page.evaluate(() => window.__sim.input.throttle);
  assert.ok(held > 0, `throttle was ${held} at click time -- the take was no longer under power`);

  await page.click('#stopRecBtn');
  assert.equal(await page.evaluate(() => window.__sim.sessionOpen), false,
    'session still open right after clicking stop');
  assert.equal(await visible(), false, 'stop button still showing after the click');

  const frames = await page.evaluate(() => window.__sim.tub.frames.length);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(await page.evaluate(() => window.__sim.tub.frames.length), frames,
    'frames kept recording after stop was clicked');
});

test('lifting off re-arms, so driving again starts a new take', async () => {
  await page.evaluate(() => { window.__sim.input.throttle = 0; });
  await waitFor(page, () => window.__sim.V.speed === 0, { message: 'car never stopped' });

  const before = await page.evaluate(() => window.__sim.tub.frames.length);
  await startTake();
  await waitFor(page, (n) => window.__sim.tub.frames.length > n, {
    args: [before],
    message: 'recording never resumed after lifting off and driving again',
  });
  assert.equal(await visible(), true, 'stop button did not come back for the new take');
  await page.evaluate(() => { window.__sim.input.throttle = 0; });
});

test('it hides again when the car is left parked', async () => {
  await waitFor(page, () => window.__sim.sessionOpen === false, {
    timeout: 15000,
    message: 'session never closed while parked',
  });
  await waitFor(page, async () => {
    const b = document.getElementById('stopRecBtn');
    return getComputedStyle(b).display === 'none';
  }, { message: 'stop button still visible after the session closed' });
});
