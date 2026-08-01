import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage } from './helpers.js';

let page, teardown;

before(async () => {
  ({ page, teardown } = await setupSimPage());
  // The sticks only render under @media(pointer:coarse); headless Chrome
  // defaults to a fine pointer. page.emulateMediaFeatures() can't override
  // 'pointer' in this puppeteer-core version (it throws "Unsupported media
  // feature: pointer", and a raw CDP Emulation.setEmulatedMedia call
  // silently no-ops for it). isMobile+hasTouch on the viewport is what
  // actually flips the browser's reported pointer capability, verified via
  // matchMedia('(pointer: coarse)').matches becoming true.
  await page.setViewport({ width: 800, height: 600, isMobile: true, hasTouch: true });
  await page.evaluate(() => { __sim.setMode('drive'); });
});
after(() => teardown());

// Dispatches real PointerEvents directly on the stick rather than using
// page.touchscreen, since the sticks' own listeners are pointer-event
// based -- this avoids any ambiguity in how Puppeteer's touch emulation
// maps to pointer events.
async function drag(stickId, dx, dy) {
  return page.evaluate(({ stickId, dx, dy }) => {
    const el = document.getElementById(stickId);
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, pointerId: 1, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', cx, cy);
    fire('pointermove', cx + dx, cy + dy);
    return { steer: window.__sim.input.steer, throttle: window.__sim.input.throttle };
  }, { stickId, dx, dy });
}

async function release(stickId) {
  return page.evaluate((stickId) => {
    const el = document.getElementById(stickId);
    el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }));
    return { steer: window.__sim.input.steer, throttle: window.__sim.input.throttle };
  }, stickId);
}

test('left stick steers continuously, correctly signed', async () => {
  // Sign convention matches input.js's mousemove handler: right -> negative
  // steer -> right turn, since +1 steer is full LEFT.
  const right = await drag('joystick', 30, 0);
  assert.ok(right.steer < 0 && right.steer > -1, `expected a fractional negative value, got ${right.steer}`);

  const left = await drag('joystick', -30, 0);
  assert.ok(left.steer > 0 && left.steer < 1, `expected a fractional positive value, got ${left.steer}`);
});

test('right stick throttles continuously, up is forward', async () => {
  // This is the point of the change: throttle used to be an on/off button
  // pegged at exactly 1.0 in every recorded frame.
  const forward = await drag('throttleStick', 0, -30);
  assert.ok(forward.throttle > 0 && forward.throttle < 1,
    `expected a fractional positive throttle, got ${forward.throttle}`);

  const braking = await drag('throttleStick', 0, 30);
  assert.ok(braking.throttle < 0 && braking.throttle > -1,
    `pulling below centre should go negative (brake/reverse), got ${braking.throttle}`);
});

test('both sticks clamp to +-1 beyond their travel', async () => {
  assert.equal((await drag('joystick', 500, 0)).steer, -1);
  assert.equal((await drag('joystick', -500, 0)).steer, 1);
  assert.equal((await drag('throttleStick', 0, -500)).throttle, 1);
  assert.equal((await drag('throttleStick', 0, 500)).throttle, -1);
});

test('each stick is axis-locked and ignores drift on the other axis', async () => {
  // The forgiving property: a thumb wandering sideways on the throttle
  // stick must not bleed into steering (or sap throttle range), and vice
  // versa. A circular 2D gate would fail this.
  await release('joystick');
  await release('throttleStick');

  const throttleWithDrift = await drag('throttleStick', 40, -30);
  assert.equal(throttleWithDrift.steer, 0, 'sideways drift on the throttle stick must not steer');
  const throttleStraight = await drag('throttleStick', 0, -30);
  assert.equal(throttleWithDrift.throttle, throttleStraight.throttle,
    'sideways drift must not change the throttle value');

  await release('throttleStick');
  const steerWithDrift = await drag('joystick', -30, 40);
  assert.equal(steerWithDrift.throttle, 0, 'vertical drift on the steering stick must not throttle');
  const steerStraight = await drag('joystick', -30, 0);
  assert.equal(steerWithDrift.steer, steerStraight.steer,
    'vertical drift must not change the steering value');
});

test('releasing a stick springs it back to zero', async () => {
  await drag('joystick', 30, 0);
  assert.equal((await release('joystick')).steer, 0, 'steer did not reset on release');

  await drag('throttleStick', 0, -30);
  assert.equal((await release('throttleStick')).throttle, 0, 'throttle did not reset on release');
});
