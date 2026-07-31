import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

let page, teardown;

before(async () => { ({ page, teardown } = await setupSimPage()); });
after(() => teardown());

test('recording indicator reflects live recording state', async () => {
  assert.equal(await page.evaluate(() => document.getElementById('recDot').classList.contains('active')), false);

  await page.evaluate(() => { __sim.input.throttle = 0.5; });
  await waitFor(page, () => document.getElementById('recDot').classList.contains('active'), {
    message: 'recording dot never activated while driving forward',
  });

  await page.evaluate(() => { __sim.input.throttle = 0; });
  await waitFor(page, () => !document.getElementById('recDot').classList.contains('active'), {
    message: 'recording dot stayed active after stopping',
  });
});

test('frame counter reflects tub.frames.length', async () => {
  await page.evaluate(async () => {
    const mod = await import('/data/tub.js');
    mod.tub.frames.length = 0;
    mod.tub.bins.fill(0);
    for (let i = 0; i < 5; i++) mod.tubPush(i, 0, 0.5);
  });
  await waitFor(page, () => document.getElementById('dFrames').textContent === '5frames', {
    message: 'frame counter did not update to 5',
  });
});

test('histogram orientation: left turns land in the left bins, right turns in the right bins', async () => {
  // steer is +1 = full left; the bin index has to run the opposite way
  // (low index = left) to land on the matching side of the display --
  // this regression-tests a bug where that was backwards.
  const bins = await page.evaluate(async () => {
    const mod = await import('/data/tub.js');
    mod.tub.frames.length = 0;
    mod.tub.bins.fill(0);
    for (let i = 0; i < 5; i++) mod.tubPush(i, 0.9, 0.5);        // hard left
    for (let i = 5; i < 10; i++) mod.tubPush(i, -0.9, 0.5);      // hard right
    return mod.tub.bins.slice();
  });
  assert.equal(bins[0], 5, 'hard-left steering should land entirely in the leftmost bin');
  assert.equal(bins[bins.length - 1], 5, 'hard-right steering should land entirely in the rightmost bin');
});
