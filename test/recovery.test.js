import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

let page, teardown;

before(async () => { ({ page, teardown } = await setupSimPage()); });
after(() => teardown());

test('Recover mode shows its own panel and hides Eval/Data chrome', async () => {
  await page.evaluate(() => { __sim.setMode('recover'); });
  const state = await page.evaluate(() => ({
    mode: document.body.dataset.mode,
    povwrapVisible: getComputedStyle(document.getElementById('povwrap')).display !== 'none',
    recoverPanelVisible: getComputedStyle(document.getElementById('recoverPanel')).display !== 'none',
    evalPanelVisible: getComputedStyle(document.getElementById('evalPanel')).display !== 'none',
  }));
  assert.equal(state.mode, 'recover');
  assert.equal(state.povwrapVisible, true, 'POV camera preview should be visible in Recover mode');
  assert.equal(state.recoverPanelVisible, true, '#recoverPanel should be visible in Recover mode');
  assert.equal(state.evalPanelVisible, false, '#evalPanel should stay hidden in Recover mode');
});

test('starting recovery generation perturbs the car off-line without the normal off-track auto-reset firing', async () => {
  await page.evaluate(() => { __sim.startRecovery(); });

  await waitFor(page, () => window.__sim.recovery.phase === 'recovering', {
    message: 'recovery never entered its recovering phase',
  });

  const justAfterPerturb = await page.evaluate(() => ({ cte: __sim.cte, throttle: __sim.input.throttle }));
  assert.ok(justAfterPerturb.cte > 0.4, `expected a meaningfully off-line perturbation, got cte=${justAfterPerturb.cte}`);

  // The ordinary off-track handling (car.js) trims + snaps back to the
  // line and zeroes the throttle the instant offTrack flips true. If that
  // fired here it would stomp the recovery controller's own throttle
  // command within the same tick it starts driving -- give it a beat and
  // confirm the controller is still in charge instead.
  await new Promise((r) => setTimeout(r, 400));
  const shortlyAfter = await page.evaluate(() => ({
    active: __sim.recovery.active,
    throttle: __sim.input.throttle,
  }));
  assert.equal(shortlyAfter.active, true, 'recovery should still be active a few ticks after perturbation');
  assert.ok(shortlyAfter.throttle > 0, 'the recovery controller\'s throttle command should not have been zeroed by the normal auto-reset');
});

test('a recovery episode records frames and eventually completes, then starts another', async () => {
  const framesBefore = await page.evaluate(() => __sim.tub.frames.length);

  await waitFor(page, () => window.__sim.recovery.successes >= 1, {
    timeout: 40000,
    message: 'no recovery episode completed successfully in time',
  });

  const framesAfter = await page.evaluate(() => __sim.tub.frames.length);
  assert.ok(framesAfter > framesBefore, 'a completed recovery episode should have recorded frames into the tub');

  const state = await page.evaluate(() => ({ active: __sim.recovery.active, phase: __sim.recovery.phase, episodes: __sim.recovery.episodes }));
  assert.equal(state.active, true, 'recovery should keep generating after a successful episode');
  assert.equal(state.phase, 'recovering', 'a new perturbation should already be underway');
  assert.ok(state.episodes >= 2, 'a new episode should have started after the first succeeded');
});

test('leaving Recover mode stops generation and puts the car back on the line', async () => {
  await page.evaluate(() => { __sim.setMode('drive'); });

  await waitFor(page, () => window.__sim.recovery.active === false, {
    message: 'recovery generation kept running after leaving Recover mode',
  });

  const state = await page.evaluate(() => ({ throttle: __sim.input.throttle, cte: __sim.cte }));
  assert.equal(state.throttle, 0, 'leaving Recover mode should zero the throttle like any other reset-to-line');
  assert.ok(state.cte < 0.01, `expected the car back on the centerline, got cte=${state.cte}`);
});
