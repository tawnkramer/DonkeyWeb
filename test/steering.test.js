import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage } from './helpers.js';

let page, teardown;

before(async () => {
  ({ page, teardown } = await setupSimPage());
  await page.setViewport({ width: 1280, height: 800 });
});

after(() => teardown());

test('mouse position maps to continuous, correctly-signed steering', async () => {
  // window is 1280 wide -> center at x=640; STEER_SENSITIVITY_PX is 260,
  // so +-260px from center should be full lock. +1 = full left (moving
  // the mouse left of center), -1 = full right.
  const cases = [
    { x: 640, expect: 0 },
    { x: 380, expect: 1 },
    { x: 900, expect: -1 },
    { x: 1020, expect: -1 }, // beyond the sensitivity window, still clamped to -1
  ];
  for (const { x, expect } of cases) {
    await page.mouse.move(x, 400);
    const steer = await page.evaluate(() => window.__sim.input.steer);
    assert.equal(steer, expect, `mouse at x=${x}`);
  }
});

test('a partial deflection produces a genuinely continuous value, not just -1/0/1', async () => {
  await page.mouse.move(500, 400); // 140px left of center, within the 260px lock range
  const steer = await page.evaluate(() => window.__sim.input.steer);
  assert.ok(steer > 0 && steer < 1, `expected a fractional value, got ${steer}`);
});

test('keyboard still snaps to full left/right and releases to 0', async () => {
  await page.keyboard.down('a');
  const left = await page.evaluate(() => window.__sim.input.steer);
  await page.keyboard.up('a');
  const released = await page.evaluate(() => window.__sim.input.steer);
  assert.equal(left, 1);
  assert.equal(released, 0);

  await page.keyboard.down('d');
  const right = await page.evaluate(() => window.__sim.input.steer);
  await page.keyboard.up('d');
  assert.equal(right, -1);
});
