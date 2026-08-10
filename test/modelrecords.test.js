import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

// A model record is written before the worker has any weights to put in it,
// because the worker needs the storage key first. That is fine right up
// until the run does not reach a save -- and "need 50+ frames to train" is
// one button press away on a fresh install. Every one of those used to leave
// a permanent entry in the picker, named identically to every real model,
// impossible to load and removable only one at a time.
let page, teardown;

before(async () => { ({ page, teardown } = await setupSimPage()); });
after(() => teardown());

const records = () => page.evaluate(async () => {
  const { dbModelGetAll } = await import('/data/db.js');
  const tf = await import('/vendor/tf.mjs');
  await tf.ready();
  const all = await dbModelGetAll();
  const stored = await tf.io.listModels();
  return all.map((r) => ({ id: r.id, name: r.name, pending: !!r.pending, saved: !!stored[r.storageKey] }));
});

// Below MIN_FRAMES, so the worker throws before it can save anything.
async function failedRun() {
  await page.evaluate(async () => {
    const { tubPush, waitForTubIdle } = await import('/data/tub.js');
    if (__sim.tub.frames.length === 0) {
      for (let i = 0; i < 20; i++) tubPush(i * 0.05, Math.sin(i) * 0.6, 0.5);
      await waitForTubIdle();
    }
    __sim.setMode('train');
  });
  await page.click('#trainBtn');
  await waitFor(page, () => window.__sim.training.state === 'error', {
    timeout: 30000, message: 'the short-tub run never reported an error',
  });
}

test('a run that never saves leaves no model behind', async () => {
  await failedRun();
  await waitFor(page, async () => {
    const { dbModelGetAll } = await import('/data/db.js');
    return (await dbModelGetAll()).length === 0;
  }, { message: 'the failed run left a model record behind' });
});

test('repeated failures do not accumulate', async () => {
  for (let i = 0; i < 3; i++) await failedRun();
  await waitFor(page, async () => {
    const { dbModelGetAll } = await import('/data/db.js');
    return (await dbModelGetAll()).length === 0;
  }, { message: 'repeated failed runs accumulated model records' });
});

test('records left by a previous version are pruned on load', async () => {
  // Exactly the wreckage the old code produced: metadata with no artifacts,
  // all named the same, and one of them marked active.
  await page.evaluate(async () => {
    const { setUserModel, setActiveModelId } = await import('/train/models.js');
    await setUserModel({ id: 'junk-1', name: 'Trained linear model', source: 'trained' });
    await setUserModel({ id: 'junk-2', name: 'Trained linear model', source: 'trained' });
    setActiveModelId('junk-2');
  });
  assert.equal((await records()).length, 2, 'setup: expected two junk records');

  await page.reload({ waitUntil: 'load', timeout: 20000 });
  await page.evaluate(() => window.__sim.getAvailableModels());
  await waitFor(page, async () => {
    const { dbModelGetAll } = await import('/data/db.js');
    return (await dbModelGetAll()).length === 0;
  }, { message: 'unloadable records survived a reload' });

  // Active must not be left pointing at something that was just deleted.
  const active = await page.evaluate(async () => {
    const { getActiveModelId } = await import('/train/models.js');
    return getActiveModelId();
  });
  assert.equal(active, 'builtin-example', 'active model should fall back when its record is pruned');
});

test('a pending record is not mistaken for a trained model', async () => {
  // `pending` marks a run in flight. Surviving a page load means that run
  // died, so it is wreckage even though the flag alone cannot say when.
  await page.evaluate(async () => {
    const { setUserModel } = await import('/train/models.js');
    await setUserModel({ id: 'in-flight', name: 'linear · whenever', source: 'trained', pending: true });
  });
  await page.reload({ waitUntil: 'load', timeout: 20000 });
  await page.evaluate(() => window.__sim.getAvailableModels());
  await waitFor(page, async () => {
    const { dbModelGetAll } = await import('/data/db.js');
    return (await dbModelGetAll()).length === 0;
  }, { message: 'a pending record survived the load that proved it dead' });
});

test('trained models get names that tell them apart', async () => {
  // Every model used to be "Trained linear model", so a list of them carried
  // no information: you could not tell this morning's good one from the four
  // made while tuning.
  const name = await page.evaluate(async () => {
    const mod = await import('/sim/trainui.js');
    return mod.trainedModelName ? mod.trainedModelName('linear') : null;
  });
  assert.ok(name, 'trainedModelName should be exported for this check');
  assert.ok(name.includes('linear'), `expected the profile in the name, got "${name}"`);
  assert.ok(/\d/.test(name), `expected something time-varying in the name, got "${name}"`);
  assert.notEqual(name, 'Trained linear model');
});
