import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

// M2 autopilot: model loading, mode switching, model-drives-the-car, and
// the shadow needle. Tests save an UNTRAINED KerasLinear straight to
// indexeddb://donkeyweb-model instead of training one -- what's under
// test is the inference/control path, and a random-init model exercises
// it in seconds instead of minutes. (Each test file gets a fresh
// puppeteer profile, so IndexedDB is empty until we put that model there.)
let page, teardown;

before(async () => { ({ page, teardown } = await setupSimPage()); });
after(() => teardown());

test('without a trained model, autopilot stays unavailable', async () => {
  // pilotui kicks off loadPilotModel() at startup; wait for that attempt
  // to settle rather than asserting mid-load.
  await waitFor(page, () => window.__sim.pilot && !window.__sim.pilot.loading, {
    timeout: 60000,
    message: 'initial loadPilotModel never settled',
  });
  const s = await page.evaluate(() => ({
    ready: __sim.pilot.ready,
    active: __sim.setPilotActive(true), // must refuse with no model
    btnDisabled: document.getElementById('pilotBtn').disabled,
  }));
  assert.equal(s.ready, false);
  assert.equal(s.active, false, 'setPilotActive(true) must be a no-op with no model loaded');
  assert.equal(s.btnDisabled, true);
});

test('a saved model enables autopilot and its predictions drive the car', async () => {
  await page.evaluate(async () => {
    const tf = await import('/vendor/tf.mjs');
    const { buildModel } = await import('/train/model.js');
    const m = buildModel(tf);
    // Give the throttle head a positive bias so this random-weight model
    // actually drives the car -- the no-recording-during-autopilot test
    // below is only meaningful if input.throttle > 0 while the pilot is on.
    const head = m.getLayer('n_outputs1');
    // getWeights() returns the layer's live variables, not copies -- do not
    // dispose them, or save() fails with "bias is already disposed".
    const [kernel] = head.getWeights();
    head.setWeights([kernel, tf.tensor1d([0.6])]);
    await m.save('indexeddb://donkeyweb-model');
    m.dispose();
  });
  const ready = await page.evaluate(() => __sim.loadPilotModel());
  assert.equal(ready, true, 'loadPilotModel should succeed once a model exists');

  const btnDisabled = await page.evaluate(() => document.getElementById('pilotBtn').disabled);
  assert.equal(btnDisabled, false, 'button should enable once the model is loaded');

  // Autopilot now lives on the Eval tab -- explicit rather than relying on
  // "nothing else in this file changes mode" as an implicit side effect.
  await page.evaluate(() => { __sim.setMode('eval'); __sim.setPilotActive(true); });
  const start = await page.evaluate(() => __sim.pilot.predCount);
  await waitFor(page, (n) => window.__sim.pilot.predCount > n + 5, {
    args: [start],
    timeout: 120000, // first predictions compile shaders on software GL
    message: 'predictions never started flowing',
  });

  const s = await page.evaluate(() => ({
    pilotSteer: __sim.pilot.steer,
    pilotThrottle: __sim.pilot.throttle,
  }));
  assert.ok(Number.isFinite(s.pilotSteer) && Math.abs(s.pilotSteer) <= 1, `pilot steer out of range: ${s.pilotSteer}`);
  assert.ok(s.pilotThrottle >= 0 && s.pilotThrottle <= 1, `pilot throttle out of range: ${s.pilotThrottle}`);

  // Poll rather than snapshot, and compare with tolerance rather than
  // equality: the loop applies pilot->input at frame START and predicts at
  // frame END, so from outside the loop input always holds the PREVIOUS
  // prediction. Consecutive predictions on near-identical frames are
  // close, so a small tolerance proves the override without racing it.
  // (Crash resets also blip input.throttle to 0 for a frame.)
  await waitFor(page, () => {
    const { input, pilot } = window.__sim;
    return Math.abs(input.steer - pilot.steer) < 0.1 &&
           Math.abs(input.throttle - pilot.throttle) < 0.1 &&
           input.throttle > 0;
  }, { timeout: 30000, message: 'model outputs were never applied to the car' });
});

test('mouse input cannot steal steering while autopilot is on', async () => {
  await page.mouse.move(100, 400); // hard left, far from screen center
  // The mousemove handler writes input.steer immediately; the next frame's
  // pre-physics override must claw it back to the model's value. Tolerance
  // rather than equality for the same one-prediction lag as above -- a
  // random-init model predicts near 0, nowhere near the mouse's hard left.
  await waitFor(page, () => {
    const { input, pilot } = window.__sim;
    return Math.abs(input.steer - pilot.steer) < 0.1;
  }, {
    timeout: 10000,
    message: 'input.steer never returned to the model value after a mousemove',
  });
});

test('autopilot laps never record into the tub', async () => {
  // Pilot is still active from the previous tests and the model's
  // throttle bias keeps it driving; recording would be happening right
  // now if the !pilot.active gate were missing.
  await waitFor(page, () => window.__sim.pilot.active && window.__sim.input.throttle > 0, {
    timeout: 30000,
    message: 'autopilot never drove with positive throttle',
  });
  const s0 = await page.evaluate(() => ({
    frames: __sim.tub.frames.length,
    pred: __sim.pilot.predCount,
  }));
  // Predictions tick at the same 20 Hz cadence as recording, so 40 more
  // predictions ≈ 2s of would-be recording (~40 frames if the gate leaked).
  await waitFor(page, (n) => window.__sim.pilot.predCount > n + 40, {
    args: [s0.pred],
    timeout: 120000,
    message: 'autopilot predictions stalled',
  });
  const s1 = await page.evaluate(() => ({
    frames: __sim.tub.frames.length,
    recDotLit: document.getElementById('recDot').classList.contains('active'),
  }));
  assert.equal(s1.frames, s0.frames, 'tub must not grow while autopilot drives');
  assert.equal(s1.recDotLit, false, 'recording indicator must stay off during autopilot');
});

test('switching autopilot off resets to the line and kills the throttle', async () => {
  // Let the pilot actually get the car moving first, so the kill is real.
  await waitFor(page, () => window.__sim.pilot.active && window.__sim.V.speed > 0.5, {
    timeout: 60000,
    message: 'autopilot never got the car moving',
  });
  await page.evaluate(() => __sim.setPilotActive(false));
  // cte updates on the next physics tick after the snap-to-line, so poll.
  await waitFor(page, () => {
    const { input, V, cte } = window.__sim;
    return input.throttle === 0 && V.speed === 0 && cte < 0.3;
  }, { timeout: 10000, message: 'deactivating autopilot did not reset car + throttle' });
});

test('R reset kills the throttle too', async () => {
  await page.evaluate(() => { __sim.input.throttle = 0.8; });
  await page.keyboard.press('r');
  await waitFor(page, () => window.__sim.input.throttle === 0 && window.__sim.V.speed === 0, {
    timeout: 10000,
    message: 'R did not zero throttle and stop the car',
  });
});

test('shadow mode: pilot keeps predicting and the needle shows, but the user drives', async () => {
  await page.evaluate(() => {
    __sim.setPilotActive(false);
    __sim.setMode('drive'); // shadow-driving is a Drive-tab thing, stated explicitly
    __sim.input.steer = 0.7;
    __sim.input.throttle = 0;
  });
  const start = await page.evaluate(() => __sim.pilot.predCount);
  await waitFor(page, (n) => window.__sim.pilot.predCount > n + 3, {
    args: [start],
    timeout: 60000,
    message: 'shadow predictions stopped after deactivating autopilot',
  });
  const s = await page.evaluate(() => ({
    steer: __sim.input.steer,
    needleDisplay: getComputedStyle(document.getElementById('steerneedle')).display,
  }));
  assert.equal(s.steer, 0.7, 'user steering must not be overridden in shadow mode');
  assert.equal(s.needleDisplay, 'block', 'needle should be visible whenever a model is loaded');
});
