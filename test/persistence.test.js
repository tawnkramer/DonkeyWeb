import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

let page, teardown;

before(async () => { ({ page, teardown } = await setupSimPage()); });
after(() => teardown());

test('recorded frames persist to IndexedDB and survive a reload', async () => {
  await page.evaluate(() => { __sim.input.throttle = 0.5; __sim.input.steer = 0.3; });
  await waitFor(page, () => window.__sim.tub.frames.length >= 5, {
    message: 'not enough frames recorded before stopping',
  });
  await page.evaluate(() => { __sim.input.throttle = 0; });

  const memCountBefore = await page.evaluate(() => __sim.tub.frames.length);

  // Image capture is async (canvas.toBlob), so the IndexedDB write can
  // lag a push by a tick or two -- poll rather than guess a delay.
  await waitFor(page, async () => {
    const { dbGetAll } = await import('/data/db.js');
    const all = await dbGetAll();
    return all.length >= 1;
  }, { timeout: 15000, message: 'no frames ever persisted to IndexedDB' });

  await page.reload({ waitUntil: 'load', timeout: 20000 });
  await waitFor(page, () => window.__sim && window.__sim.tub.loaded, {
    timeout: 10000,
    message: 'tub never finished restoring after reload',
  });

  const memCountAfter = await page.evaluate(() => __sim.tub.frames.length);
  assert.ok(memCountAfter >= 1, 'expected at least some frames restored after reload');
  assert.ok(memCountAfter <= memCountBefore, 'restored count should never exceed what was actually recorded');
});

test('recording after a reload continues with non-colliding ids', async () => {
  const countBefore = await page.evaluate(() => __sim.tub.frames.length);

  await page.evaluate(() => { __sim.input.throttle = 0.5; });
  await waitFor(page, (n) => window.__sim.tub.frames.length > n, {
    args: [countBefore],
    message: 'no new frames recorded after reload',
  });
  await page.evaluate(() => { __sim.input.throttle = 0; });

  const idsAfter = await page.evaluate(() => __sim.tub.frames.map((f) => f.id));
  const unique = new Set(idsAfter).size === idsAfter.length;
  assert.ok(unique, `expected all frame ids to be unique, got ${JSON.stringify(idsAfter)}`);
  assert.ok(idsAfter.length > countBefore, 'expected new frames on top of the restored ones');
});

test('trimming never leaves an orphaned or resurrected record in IndexedDB, regardless of JPEG-encode timing', async () => {
  // Don't assume ids start at 0 here -- nextId has already advanced from
  // the earlier tests in this file sharing the same page/module state.
  // Capture the actually-assigned ids instead of guessing them.
  const { survivors, allPushed } = await page.evaluate(async () => {
    const mod = await import('/data/tub.js');
    await mod.waitForTubIdle();
    const { dbClear } = await import('/data/db.js');
    await dbClear();
    mod.tub.frames.length = 0;
    mod.tub.bins.fill(0);
    const allPushed = [];
    for (let i = 0; i < 10; i++) {
      mod.tubPush(i, 0, 0.5); // t = 0..9
      allPushed.push(mod.tub.frames[mod.tub.frames.length - 1].id);
    }
    // Trim immediately, before most (or any) of the async toBlob
    // callbacks above have fired -- this is exactly the race that
    // needs the frame.trimmed guard in tubPush to not resurrect a
    // deleted frame once its encode finally completes.
    mod.tubTrimLastSeconds(3, 9); // keeps t=0..6 (7 frames), drops t=7,8,9
    return { survivors: mod.tub.frames.map((f) => f.id), allPushed };
  });
  assert.equal(survivors.length, 7, `expected 7 survivors, got ${JSON.stringify(survivors)}`);
  assert.deepEqual(survivors, allPushed.slice(0, 7));

  const dbIds = await waitFor(page, async (expected) => {
    const { dbGetAll } = await import('/data/db.js');
    const all = await dbGetAll();
    const ids = all.map((r) => r.id).sort((a, b) => a - b);
    return JSON.stringify(ids) === JSON.stringify(expected) ? ids : false;
  }, { args: [survivors], timeout: 15000, message: 'IndexedDB never converged to the surviving frames' });

  assert.deepEqual(dbIds, survivors);
});
