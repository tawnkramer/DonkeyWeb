import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

let page, teardown;

before(async () => { ({ page, teardown } = await setupSimPage()); });
after(() => teardown());

test('fresh sessions expose the immutable built-in model in Eval', async () => {
  await waitFor(page, () => window.__sim.pilot && window.__sim.pilot.ready, {
    timeout: 60000,
    message: 'built-in model never finished loading',
  });
  const state = await page.evaluate(() => ({
    ready: __sim.pilot.ready,
    modelId: __sim.pilot.modelId,
    options: [...document.querySelectorAll('#modelSelect option')].map(option => option.value),
    label: document.querySelector('#modelSelect option')?.textContent,
  }));
  assert.equal(state.ready, true);
  assert.equal(state.modelId, 'builtin-example');
  assert.deepEqual(state.options, ['builtin-example']);
  assert.match(state.label, /built-in/i);
});

test('models menu opens as a touch-sized mobile control', async () => {
  await page.setViewport({ width: 375, height: 667, isMobile: true, hasTouch: true });
  await page.click('#modelMenuBtn');
  const state = await page.evaluate(() => {
    const menu = document.getElementById('modelMenu').getBoundingClientRect();
    const button = document.getElementById('modelMenuBtn').getBoundingClientRect();
    return {
      open: document.getElementById('modelMenu').classList.contains('open'),
      menuWidth: menu.width,
      buttonWidth: button.width,
      loadText: document.getElementById('loadModelBtn').textContent,
      saveText: document.getElementById('saveModelBtn').textContent,
    };
  });
  assert.equal(state.open, true);
  assert.ok(state.menuWidth >= 200);
  assert.ok(state.buttonWidth >= 34);
  assert.equal(state.loadText, 'load model');
  assert.equal(state.saveText, 'save current model');

  await page.click('#deleteModelBtn');
  assert.equal(await page.$eval('#modelMenuStatus', el => el.textContent), 'the built-in model cannot be deleted');
});

test('mobile Eval hides the panel while driving and touch stops Autopilot', async () => {
  await page.evaluate(() => { __sim.setMode('eval'); __sim.setPilotActive(true); });
  await waitFor(page, () => window.__sim.pilot.active, { message: 'Autopilot did not start for mobile panel test' });
  const running = await page.evaluate(() => {
    const style = getComputedStyle(document.getElementById('evalPanel'));
    return {
      hidden: style.display === 'none',
      bottomGap: parseFloat(style.bottom),
    };
  });
  assert.equal(running.hidden, true);
  assert.ok(running.bottomGap >= 10 && running.bottomGap < 40, `unexpected bottom gap ${running.bottomGap}`);

  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true })));
  await waitFor(page, () => !window.__sim.pilot.active, { message: 'touch did not stop mobile Autopilot' });
  assert.notEqual(await page.$eval('#evalPanel', el => getComputedStyle(el).display), 'none');
});
