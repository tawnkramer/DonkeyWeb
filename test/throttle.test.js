import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage } from './helpers.js';

let page, teardown;

before(async () => { ({ page, teardown } = await setupSimPage()); });
after(() => teardown());

async function throttle() {
  return page.evaluate(() => window.__sim.input.throttle);
}

test('scroll wheel adjusts throttle continuously and holds (no decay while idle)', async () => {
  assert.equal(await throttle(), 0);

  await page.mouse.wheel({ deltaY: -200 }); // scroll "up" -> more gas
  const afterOneScroll = await throttle();
  assert.ok(afterOneScroll > 0 && afterOneScroll < 1, `expected a fractional bump, got ${afterOneScroll}`);

  await page.mouse.wheel({ deltaY: -200 });
  const afterTwoScrolls = await throttle();
  assert.ok(afterTwoScrolls > afterOneScroll, 'a second scroll should add more throttle, not reset it');

  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await throttle(), afterTwoScrolls, 'throttle must not decay just from sitting idle');

  await page.mouse.wheel({ deltaY: 5000 }); // large scroll down
  assert.equal(await throttle(), -1, 'should clamp at -1, not go past it');
});

test('keyboard still snaps throttle to full gas/brake and releases to 0', async () => {
  await page.keyboard.down('w');
  assert.equal(await throttle(), 1);
  await page.keyboard.up('w');
  assert.equal(await throttle(), 0);

  await page.keyboard.down('s');
  assert.equal(await throttle(), -1);
  await page.keyboard.up('s');
  assert.equal(await throttle(), 0);
});
