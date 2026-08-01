import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

let page, teardown;

before(async () => { ({ page, teardown } = await setupSimPage()); });
after(() => teardown());

test('nav buttons switch the active mode and show only that screen', async () => {
  for (const mode of ['data', 'train', 'eval', 'drive']) {
    await page.click(`.navbtn[data-mode="${mode}"]`);
    await waitFor(page, (m) => document.body.dataset.mode === m, {
      args: [mode],
      message: `body.dataset.mode never became "${mode}"`,
    });

    const state = await page.evaluate(() => ({
      activeCount: document.querySelectorAll('.navbtn.active').length,
      activeMode: document.querySelector('.navbtn.active')?.dataset.mode,
      screenDataVisible: getComputedStyle(document.getElementById('screenData')).display !== 'none',
      screenTrainVisible: getComputedStyle(document.getElementById('screenTrain')).display !== 'none',
      povwrapVisible: getComputedStyle(document.getElementById('povwrap')).display !== 'none',
      evalPanelVisible: getComputedStyle(document.getElementById('evalPanel')).display !== 'none',
    }));

    assert.equal(state.activeCount, 1, `expected exactly one active nav button in ${mode} mode`);
    assert.equal(state.activeMode, mode, `active nav button should match mode ${mode}`);
    assert.equal(state.screenDataVisible, mode === 'data', `#screenData visibility wrong in ${mode} mode`);
    assert.equal(state.screenTrainVisible, mode === 'train', `#screenTrain visibility wrong in ${mode} mode`);
    assert.equal(state.povwrapVisible, mode === 'drive' || mode === 'eval', `#povwrap visibility wrong in ${mode} mode`);
    assert.equal(state.evalPanelVisible, mode === 'eval', `#evalPanel visibility wrong in ${mode} mode`);
  }
});

test('leaving Drive/Eval stops recording even if throttle is still held', async () => {
  await page.evaluate(async () => {
    __sim.setMode('drive');
    const mod = await import('/data/tub.js');
    mod.tub.frames.length = 0;
    mod.tub.bins.fill(0);
  });

  await page.evaluate(() => { __sim.input.throttle = 0.5; });
  await waitFor(page, () => window.__sim.tub.frames.length > 0, {
    message: 'never started recording while driving forward in Drive mode',
  });

  await page.evaluate(() => { __sim.setMode('data'); });
  const countAfterSwitch = await page.evaluate(() => __sim.tub.frames.length);
  // A bounded wait rather than waitFor here on purpose: this asserts an
  // absence of further activity (recording staying stopped), which
  // waitFor's "poll until truthy" can't express. REC_DT is 50ms, so this
  // covers several recording ticks' worth of opportunity for the bug to
  // reappear.
  await new Promise((r) => setTimeout(r, 500));
  const countLater = await page.evaluate(() => __sim.tub.frames.length);
  assert.equal(countLater, countAfterSwitch, 'tub kept growing while on the Data tab with throttle still held');

  await page.evaluate(() => { __sim.input.throttle = 0; __sim.setMode('drive'); });
});

test('switching away from Eval while autopilot is active auto-stops it', async () => {
  // Forces pilot.ready rather than running a real training pass: this
  // test is about the mode-change -> setPilotActive(false) wiring in
  // main.js, not about training/inference, which is already covered (and
  // expensive) elsewhere.
  await page.evaluate(() => {
    __sim.setMode('eval');
    __sim.pilot.ready = true;
    __sim.setPilotActive(true);
  });
  const activeInEval = await page.evaluate(() => __sim.pilot.active);
  assert.equal(activeInEval, true, 'setPilotActive(true) did not activate with pilot.ready forced true');

  await page.evaluate(() => { __sim.setMode('data'); });
  await waitFor(page, () => window.__sim.pilot.active === false, {
    message: 'autopilot stayed active after leaving Eval mode',
  });

  await page.evaluate(() => { __sim.pilot.ready = false; __sim.setMode('drive'); });
});
