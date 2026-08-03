import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage } from './helpers.js';

let page, teardown;

// navigator.getGamepads is replaced with one that reports a fake
// standard-mapping pad we can drive from the test. That is the whole API
// surface gamepad.js touches, so everything below it -- deadzones,
// ownership, sign conventions -- is the real code path.
//
// A fake is used for control, not because a real pad is invisible here:
// headless Chrome DOES see a controller attached to the host, which is
// why setupSimPage() stubs it out first (see blockRealGamepads). This
// redefinition deliberately lands on top of that stub.
async function installFakePad() {
  await page.evaluate(() => {
    window.__pad = {
      id: 'Test Pad (STANDARD GAMEPAD Vendor: 0000 Product: 0000)',
      index: 0, connected: true, mapping: 'standard',
      // A small resting offset, baked in before the first poll can happen
      // -- see the connect test for why it has to be set here rather than
      // pushed in afterwards.
      axes: [0.05, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    };
    window.__padPresent = true;
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => (window.__padPresent ? [window.__pad] : []),
    });
  });
}

// Sets the pad's raw state, polls once, and reports what the sim now
// reads. Polling explicitly (rather than waiting on the rAF loop, which
// also polls) keeps every assertion deterministic: page.evaluate runs to
// completion synchronously, so no frame can land mid-check.
async function poll(state = {}) {
  return page.evaluate((state) => {
    const pad = window.__pad;
    if (state.axes) state.axes.forEach((v, i) => { if (v != null) pad.axes[i] = v; });
    if (state.buttons) {
      for (const [i, v] of Object.entries(state.buttons)) {
        pad.buttons[i] = { pressed: v > 0.5, value: v };
      }
    }
    window.__sim.pollGamepads();
    const { input, source, gamepad } = window.__sim;
    return {
      steer: input.steer, throttle: input.throttle,
      source: { ...source },
      connected: gamepad.connected, throttleControl: gamepad.throttleControl,
    };
  }, state);
}

before(async () => {
  ({ page, teardown } = await setupSimPage());
  await page.setViewport({ width: 800, height: 600 });
  await page.evaluate(() => { __sim.setMode('drive'); });
  await installFakePad();
});
after(() => teardown());

test('a freshly connected pad announces itself without grabbing an axis', async () => {
  // The seeding poll matters: a controller whose sticks rest off centre
  // must not steal steering the instant it is plugged in, before the user
  // has touched it. The resting offset is part of the pad's initial state
  // rather than something this test pushes in, because the sim's own
  // frame loop is also polling -- whichever poll lands first has to see
  // the same resting value, or the change between them reads as motion.
  await page.evaluate(() => { __sim.input.steer = 0.42; });
  const first = await poll();
  assert.equal(first.connected, true, 'pad should be detected on the first poll');
  assert.equal(first.steer, 0.42, 'connecting must not overwrite the current steer value');
  assert.notEqual(first.source.steer, 'gamepad');

  const toast = await page.evaluate(() => {
    const el = document.getElementById('padToast');
    return { text: el.textContent, hidden: el.classList.contains('gone') };
  });
  assert.match(toast.text, /Test Pad/, 'connect toast should name the pad');
  assert.ok(!toast.hidden, 'connect toast should be visible');
  assert.ok(!/Vendor/.test(toast.text), 'vendor noise should be stripped from the pad name');
});

test('left stick steers continuously, correctly signed', async () => {
  // Same convention as the mouse and the touch sticks: pushing right
  // produces negative steer, since +1 is full LEFT.
  const right = await poll({ axes: [0.5, 0, 0, 0] });
  assert.ok(right.steer < 0 && right.steer > -1, `expected a fractional negative value, got ${right.steer}`);
  assert.equal(right.source.steer, 'gamepad');

  const left = await poll({ axes: [-0.5, 0, 0, 0] });
  assert.ok(left.steer > 0 && left.steer < 1, `expected a fractional positive value, got ${left.steer}`);
  assert.ok(Math.abs(left.steer + right.steer) < 1e-9, 'mirrored deflections should give mirrored values');

  assert.equal((await poll({ axes: [1, 0, 0, 0] })).steer, -1, 'full deflection should clamp to -1');
});

test('stick deadzone is rescaled, not clipped', async () => {
  // Derived from the live constant rather than hardcoded: the deadzone is
  // explicitly a feel knob that gets retuned against real hardware, and a
  // test that has to be edited alongside it is a test that will be edited
  // to whatever the new code does.
  const dz = await page.evaluate(() => __sim.gamepad.deadzone);
  assert.equal((await poll({ axes: [dz * 0.7, 0, 0, 0] })).steer, 0, 'resting slop must read as exactly centred');

  // Just outside the deadzone must be a small value, not a jump to the
  // deadzone width -- small corrections are the part of the steering
  // signal that a cloned policy most needs to be continuous.
  const nudge = (await poll({ axes: [dz + 0.04, 0, 0, 0] })).steer;
  assert.ok(nudge < 0 && nudge > -0.1, `expected a small negative value just past the deadzone, got ${nudge}`);
});

test('releasing the stick returns the car to centre', async () => {
  await poll({ axes: [0.6, 0, 0, 0] });
  // A released stick springs back on its own and then stops moving; the
  // sim only sees that because an owned axis is rewritten every poll.
  assert.equal((await poll({ axes: [0, 0, 0, 0] })).steer, 0);
});

test('triggers throttle forward and brake in reverse', async () => {
  const gas = await poll({ buttons: { 7: 0.6 } });
  assert.ok(gas.throttle > 0 && gas.throttle < 1, `expected a fractional positive throttle, got ${gas.throttle}`);
  assert.equal(gas.source.throttle, 'gamepad');
  assert.equal(gas.throttleControl, 'triggers');

  const brake = await poll({ buttons: { 6: 1, 7: 0 } });
  assert.equal(brake.throttle, -1, 'left trigger alone should be full brake/reverse');
  await poll({ buttons: { 6: 0, 7: 0 } });
});

test('the right stick is an alternate throttle, claimed by moving it', async () => {
  const stick = await poll({ axes: [0, 0, 0, -0.5] });
  assert.equal(stick.throttleControl, 'stick');
  assert.ok(stick.throttle > 0, `pushing the right stick up should go forward, got ${stick.throttle}`);

  // Reaching for the triggers hands throttle straight back to them --
  // the same last-active rule as between devices, applied within the pad.
  const backToTriggers = await poll({ buttons: { 7: 0.8 } });
  assert.equal(backToTriggers.throttleControl, 'triggers');
  await poll({ axes: [0, 0, 0, 0], buttons: { 7: 0 } });
});

test('a resting pad does not stamp out mouse steering', async () => {
  // The regression this whole ownership layer exists for: the pad is
  // polled every frame whether or not anyone is touching it, so without
  // ownership a controller sitting on the desk at 0 would erase mouse
  // input 60 times a second.
  await poll({ axes: [0.5, 0, 0, 0] }); // pad takes steering

  await page.mouse.move(530, 300);
  const afterMouse = await page.evaluate(() => ({ steer: __sim.input.steer, source: __sim.source.steer }));
  assert.equal(afterMouse.source, 'mouse', 'moving the mouse should hand steering to the mouse');
  assert.ok(afterMouse.steer < 0, `mouse right of centre should steer right, got ${afterMouse.steer}`);

  const held = await poll(); // pad unchanged, still deflected
  assert.equal(held.steer, afterMouse.steer, 'an untouched pad must not overwrite the mouse');
  assert.equal(held.source.steer, 'mouse');

  // ...and picking the pad back up takes it straight back.
  const reclaimed = await poll({ axes: [0.7, 0, 0, 0] });
  assert.equal(reclaimed.source.steer, 'gamepad');
  assert.ok(reclaimed.steer < afterMouse.steer, 'the pad should be driving again');
});

test('start button resets to the line', async () => {
  await page.evaluate(() => { __sim.V.speed = 5; });
  await poll({ buttons: { 9: 1 } });
  assert.equal(await page.evaluate(() => __sim.V.speed), 0, 'start should reset the car');

  // Edge-triggered: holding the button must not fire a reset every frame.
  // The car coasts (drag) between the two reads, so the check is "still
  // rolling", not "still exactly 5".
  await page.evaluate(() => { __sim.V.speed = 5; });
  await poll({ buttons: { 9: 1 } });
  assert.ok(await page.evaluate(() => __sim.V.speed) > 1, 'a held button should not re-fire');
  await poll({ buttons: { 9: 0 } });
});

test('a pad that disappears mid-drive hands back a zeroed axis', async () => {
  await poll({ axes: [0.5, 0, 0, 0], buttons: { 7: 0.8 } });
  const gone = await page.evaluate(() => {
    window.__padPresent = false;
    window.__sim.pollGamepads();
    const { input, source, gamepad } = window.__sim;
    return { steer: input.steer, throttle: input.throttle, source: { ...source }, connected: gamepad.connected };
  });
  assert.equal(gone.connected, false);
  // A dead controller must not leave the car pinned at its last throttle.
  assert.equal(gone.throttle, 0, 'throttle should fall to zero when the pad vanishes');
  assert.equal(gone.steer, 0, 'steering should centre when the pad vanishes');
  assert.notEqual(gone.source.throttle, 'gamepad');

  const toast = await page.evaluate(() => document.getElementById('padToast').textContent);
  assert.match(toast, /disconnect/i);
});
