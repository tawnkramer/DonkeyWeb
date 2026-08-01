import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage } from './helpers.js';

let page, teardown;

before(async () => {
  ({ page, teardown } = await setupSimPage());
  // The joystick only renders under @media(pointer:coarse); headless
  // Chrome defaults to a fine pointer. page.emulateMediaFeatures() can't
  // override 'pointer'/'hover' in this puppeteer-core version (verified:
  // it throws "Unsupported media feature: pointer", and even a raw CDP
  // Emulation.setEmulatedMedia call silently no-ops for it -- Chrome only
  // supports overriding prefers-color-scheme/reduced-motion/color-gamut
  // that way). isMobile+hasTouch on the viewport is what actually flips
  // the browser's real pointer/hover capability reporting, verified
  // directly: matchMedia('(pointer: coarse)').matches becomes true.
  await page.setViewport({ width: 800, height: 600, isMobile: true, hasTouch: true });
  await page.evaluate(() => { __sim.setMode('drive'); });
});
after(() => teardown());

// Dispatches real PointerEvents directly on #joystick (rather than
// page.touchscreen) since the joystick's own listeners are pointer-event-
// based -- this avoids any ambiguity in how Puppeteer's touch emulation
// maps to pointer events.
async function dragJoystick(dx, dy) {
  return page.evaluate(({ dx, dy }) => {
    const el = document.getElementById('joystick');
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, pointerId: 1, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', cx, cy);
    fire('pointermove', cx + dx, cy + dy);
    return window.__sim.input.steer;
  }, { dx, dy });
}

async function releaseJoystick() {
  return page.evaluate(() => {
    const el = document.getElementById('joystick');
    el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }));
    return window.__sim.input.steer;
  });
}

test('dragging the joystick produces continuous, correctly-signed steering', async () => {
  // JOY_RADIUS_PX is 48; same sign convention as the mousemove handler:
  // drag right -> negative steer -> right turn (+1 steer = full left).
  const rightSteer = await dragJoystick(24, 0); // half the radius, right
  assert.ok(rightSteer < 0 && rightSteer > -1, `expected a fractional negative value, got ${rightSteer}`);

  const leftSteer = await dragJoystick(-24, 0); // half the radius, left
  assert.ok(leftSteer > 0 && leftSteer < 1, `expected a fractional positive value, got ${leftSteer}`);
});

test('dragging beyond the joystick radius clamps to +-1', async () => {
  const right = await dragJoystick(500, 0);
  assert.equal(right, -1, `expected full-right clamp, got ${right}`);

  const left = await dragJoystick(-500, 0);
  assert.equal(left, 1, `expected full-left clamp, got ${left}`);
});

test('releasing the joystick resets steer to exactly 0', async () => {
  await dragJoystick(30, 0);
  const steer = await releaseJoystick();
  assert.equal(steer, 0, 'steer did not reset to 0 on release');
});
