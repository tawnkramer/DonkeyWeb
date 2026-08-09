import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

// End-to-end M1: hand-driven frames in the tub -> worker-trained
// KerasLinear clone -> model saved to tfjs's IndexedDB. Training runs in
// a worker on whatever backend headless Chrome offers (software WebGL or
// cpu), so timeouts here are generous rather than tuned: the CDN tfjs
// fetch alone has shown multi-second latency in this sandbox.
let page, teardown;

before(async () => {
  ({ page, teardown } = await setupSimPage());
  // tfjs persists models in its own 'tensorflowjs' DB, which
  // resetIndexedDB (donkeyweb only) doesn't touch -- clear it so the
  // "model was saved" assertion can't pass on a stale model from an
  // earlier run.
  await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('tensorflowjs');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  }));
});
after(() => teardown());

// Fill the tub via tubPush directly instead of actually driving: recording
// pauses whenever the car leaves the track, so scripted constant-steer
// "driving" stalls within a couple of sim seconds, and real recording is
// already covered by recording/persistence tests. tubPush snapshots the
// live POV canvas, so these are real 160x120 JPEGs with a varied steering
// signal -- exactly what the trainer consumes.
async function recordFrames(minFrames) {
  await page.evaluate(async (n) => {
    const { tubPush, waitForTubIdle } = await import('/data/tub.js');
    for (let i = 0; i < n; i++) tubPush(i * 0.05, Math.sin(i / 5) * 0.5, 0.5);
    // Wait for the async JPEG encodes/DB writes to land: the worker trains
    // on what's actually in IndexedDB, not the in-memory frame list.
    await waitForTubIdle();
  }, minFrames);
}

test('recorded laps train a model with finite losses and save it to IndexedDB', async () => {
  await recordFrames(60);

  await page.evaluate(() => __sim.trainStart({ epochs: 2, batchSize: 16 }));

  await waitFor(page, () => {
    const t = window.__sim.training;
    if (t.state === 'error') throw new Error(t.error);
    return t.state === 'done';
  }, { timeout: 240000, interval: 500, message: 'training never reached done' });

  const t = await page.evaluate(() => {
    const { state, backend, epochLog, batchLosses, nTrain, nVal, stopped, valAccuracy } = __sim.training;
    return { state, backend, epochLog, batchLosses, nTrain, nVal, stopped, valAccuracy };
  });
  assert.equal(t.stopped, false);
  assert.ok(t.nTrain > 0 && t.nVal > 0, `expected a train/val split, got ${t.nTrain}/${t.nVal}`);
  assert.ok(t.batchLosses.length > 0, 'expected per-batch loss reports');
  assert.ok(t.batchLosses.every(Number.isFinite), `non-finite batch loss in ${JSON.stringify(t.batchLosses)}`);
  assert.equal(t.epochLog.length, 2, `expected 2 epoch reports, got ${JSON.stringify(t.epochLog)}`);
  for (const e of t.epochLog) {
    assert.ok(Number.isFinite(e.loss), `non-finite train loss: ${JSON.stringify(e)}`);
    assert.ok(Number.isFinite(e.valLoss), `non-finite val loss: ${JSON.stringify(e)}`);
    assert.ok(Number.isFinite(e.valAccuracy), `non-finite val accuracy: ${JSON.stringify(e)}`);
    assert.ok(e.valAccuracy >= 0 && e.valAccuracy <= 1, `val accuracy out of range: ${JSON.stringify(e)}`);
  }

  // The per-epoch sample frame: one recorded frame re-predicted every epoch
  // for the Train tab's "sample / prediction / error" panel. Checked as
  // booleans/numbers rather than returning the bitmap itself -- an
  // ImageBitmap isn't meaningfully asserted on after crossing the CDP
  // evaluate boundary.
  const sample = await page.evaluate(() => {
    const s = __sim.training.sample;
    return s && {
      hasBitmap: !!s.bitmap, w: s.bitmap && s.bitmap.width, h: s.bitmap && s.bitmap.height,
      target: s.target, prediction: s.prediction,
    };
  });
  assert.ok(sample, 'expected training.sample to be populated after training');
  assert.ok(sample.hasBitmap, 'expected training.sample.bitmap to be present');
  assert.equal(sample.w, 160, `sample bitmap should be the model's input width, got ${sample.w}`);
  assert.equal(sample.h, 120, `sample bitmap should be the model's input height, got ${sample.h}`);
  assert.ok(Number.isFinite(sample.target.steer) && Number.isFinite(sample.target.throttle),
    `non-finite sample target: ${JSON.stringify(sample.target)}`);
  assert.ok(Number.isFinite(sample.prediction.steer) && Number.isFinite(sample.prediction.throttle),
    `non-finite sample prediction: ${JSON.stringify(sample.prediction)}`);

  const sampleDom = await page.evaluate(() => ({
    hidden: document.getElementById('trainSample').hidden,
    steerTarget: document.getElementById('sampleSteerTarget').textContent,
    steerPred: document.getElementById('sampleSteerPred').textContent,
  }));
  assert.equal(sampleDom.hidden, false, 'expected #trainSample to be shown once a sample exists');
  assert.notEqual(sampleDom.steerTarget, '—', 'expected the sample panel to show a recorded steering value');
  assert.notEqual(sampleDom.steerPred, '—', 'expected the sample panel to show a predicted steering value');

  const saved = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('tensorflowjs');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('models_store')) { db.close(); resolve(null); return; }
      const get = db.transaction('models_store', 'readonly').objectStore('models_store').get('donkeyweb-model');
      get.onerror = () => { db.close(); resolve(null); };
      get.onsuccess = () => {
        const r = get.result;
        db.close();
        resolve(r ? {
          hasTopology: !!(r.modelArtifacts && r.modelArtifacts.modelTopology),
          weightBytes: (r.modelArtifacts && r.modelArtifacts.weightData && r.modelArtifacts.weightData.byteLength) || 0,
        } : null);
      };
    };
  }));
  assert.ok(saved, 'no model record found at donkeyweb-model in the tensorflowjs DB');
  assert.ok(saved.hasTopology, 'saved model has no topology');
  assert.ok(saved.weightBytes > 100000, `saved weights suspiciously small: ${saved.weightBytes} bytes`);
});

// The phone profile. It exists to fit in a mobile GPU's memory, so what
// matters is that the whole loop still closes at a different input size:
// train at 64x64, load, and predict from the 160x120 POV feed.
test('the tiny profile trains and then drives at its own input size', async () => {
  await page.evaluate(() => __sim.trainStart({ epochs: 1, batchSize: 8, profile: 'tiny' }));
  await waitFor(page, () => {
    const t = window.__sim.training;
    if (t.state === 'error') throw new Error(t.error);
    return t.state === 'done';
  }, { timeout: 240000, interval: 500, message: 'tiny-profile training never reached done' });

  const ready = await page.evaluate(() => __sim.loadPilotModel());
  assert.equal(ready, true, 'the tiny model should load for inference');

  const shape = await page.evaluate(async () => {
    const tf = await import('/vendor/tf.mjs');
    const m = await tf.loadLayersModel('indexeddb://donkeyweb-model');
    return m.inputs[0].shape;
  });
  assert.deepEqual(shape, [null, 64, 64, 3]);

  // The POV feed is still 160x120: predicting from it proves the resize
  // path, not just that a model loaded.
  const predicted = await page.evaluate(async () => {
    // Same module instance the sim uses -- a dynamic import of an
    // already-loaded URL returns the live singleton, not a second copy.
    const { pilotPredict, pilot } = await import('/train/autopilot.js');
    const before = pilot.predCount;
    const pov = document.getElementById('pov');
    const img = pov.getContext('2d').getImageData(0, 0, pov.width, pov.height);
    pilotPredict(img);
    return { advanced: pilot.predCount > before, steer: pilot.steer };
  });
  assert.ok(predicted.advanced, 'pilotPredict did not run');
  assert.ok(Number.isFinite(predicted.steer), `steer was ${predicted.steer}`);
});

test('stop ends a long training early and still saves', async () => {
  await page.evaluate(() => __sim.trainStart({ epochs: 50, batchSize: 16 }));

  // Let it get through at least a few batches so stop lands mid-run,
  // proving early-stop rather than winning a race with a fast finish.
  await waitFor(page, () => {
    const t = window.__sim.training;
    if (t.state === 'error') throw new Error(t.error);
    return t.batchLosses.length >= 3;
  }, { timeout: 240000, interval: 200, message: 'training never produced 3 batches' });

  // Mid-run progress readout. This is what tells you a slow device is
  // working rather than wedged, so it has to appear DURING the run -- an
  // assertion after 'done' would prove nothing.
  const line = await waitFor(page, () => {
    const el = document.getElementById('trainProgress');
    return el && /batch \d+\/\d+/.test(el.textContent) ? el.textContent : null;
  }, { timeout: 60000, message: '#trainProgress never showed a batch count while running' });
  const { nTrain, batchesTotal } = await page.evaluate(() => __sim.training);
  assert.equal(batchesTotal, Math.ceil(nTrain / 16) * 50);
  assert.match(line, new RegExp(`batch \\d+/${batchesTotal}`));

  await page.evaluate(() => __sim.trainStop());
  await waitFor(page, () => {
    const t = window.__sim.training;
    if (t.state === 'error') throw new Error(t.error);
    return t.state === 'done';
  }, { timeout: 240000, interval: 500, message: 'training never stopped after trainStop()' });

  const t = await page.evaluate(() => {
    const { stopped, epochLog } = __sim.training;
    return { stopped, epochLog };
  });
  assert.equal(t.stopped, true, 'expected the run to report it was stopped');
  assert.ok(t.epochLog.length < 50, `expected fewer than 50 epochs, got ${t.epochLog.length}`);
});
