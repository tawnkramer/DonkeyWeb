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

  // Gradient saliency, one map per output head. The substantive assertion is
  // that the maps are not uniform: an all-zero map is what a broken gradient
  // path produces (model.predict instead of model.apply, a backend missing a
  // conv backprop kernel), and it would still be the right length and the
  // right byte range, so length checks alone would pass a dead feature.
  const saliency = await page.evaluate(() => {
    const s = __sim.training.sample;
    const stat = (m) => {
      if (!m) return null;
      let max = 0, nonZero = 0, outOfRange = 0;
      for (const v of m) {
        if (v > max) max = v;
        if (v > 0) nonZero++;
        if (v < 0 || v > 255) outOfRange++;
      }
      return { len: m.length, max, nonZero, outOfRange };
    };
    return { steer: stat(s && s.saliency && s.saliency.steer), throttle: stat(s && s.saliency && s.saliency.throttle) };
  });
  for (const head of ['steer', 'throttle']) {
    const m = saliency[head];
    assert.ok(m, `expected a ${head} saliency map on training.sample`);
    assert.equal(m.len, 160 * 120, `${head} saliency should be one byte per input pixel, got ${m.len}`);
    assert.equal(m.outOfRange, 0, `${head} saliency has bytes outside 0..255`);
    assert.ok(m.max > 0, `${head} saliency is entirely zero -- the gradient path is broken`);
    assert.ok(m.nonZero > m.len * 0.01,
      `${head} saliency is nearly all zero (${m.nonZero}/${m.len} non-zero) -- expected a real gradient`);
  }

  // The overlay defaults to the steering head, and 'off' has to actually
  // clear it -- the toggle is the only way back to the unobscured frame.
  const overlay = await page.evaluate(() => {
    const canvas = document.getElementById('sampleSaliency');
    const pressed = () => [...document.querySelectorAll('.salBtn')]
      .filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.sal);
    const before = { hidden: canvas.hidden, pressed: pressed(), w: canvas.width, h: canvas.height };
    document.querySelector('.salBtn[data-sal="off"]').click();
    const off = { hidden: canvas.hidden, pressed: pressed() };
    document.querySelector('.salBtn[data-sal="throttle"]').click();
    return { before, off, throttle: { hidden: canvas.hidden, pressed: pressed() } };
  });
  assert.deepEqual(overlay.before.pressed, ['steer'], 'expected the steer head to be selected by default');
  assert.equal(overlay.before.hidden, false, 'expected the saliency overlay to be visible by default');
  assert.equal(overlay.before.w, 160, `overlay buffer should match the input width, got ${overlay.before.w}`);
  assert.equal(overlay.before.h, 120, `overlay buffer should match the input height, got ${overlay.before.h}`);
  assert.equal(overlay.off.hidden, true, 'expected "off" to hide the saliency overlay');
  assert.deepEqual(overlay.off.pressed, ['off'], 'expected "off" to be the only pressed button');
  assert.equal(overlay.throttle.hidden, false, 'expected selecting the throttle head to show the overlay again');
  assert.deepEqual(overlay.throttle.pressed, ['throttle'], 'expected the throttle head to be the only pressed button');

  // Enlarging is CSS-only, so the check that matters is that the drawing
  // buffers are NOT resized with it -- rebuilding them at display size would
  // resample the frame and quietly destroy the pixel-for-pixel registration
  // between the overlay and the input it describes.
  const zoom = await page.evaluate(() => {
    const panel = document.getElementById('trainSample');
    const frame = document.getElementById('sampleFrameWrap');
    const base = document.getElementById('sampleCanvas');
    const over = document.getElementById('sampleSaliency');
    const snap = () => ({
      zoomed: panel.classList.contains('zoomed'),
      expanded: frame.getAttribute('aria-expanded'),
      shown: Math.round(frame.getBoundingClientRect().width),
      buffers: [base.width, base.height, over.width, over.height],
    });
    const before = snap();
    frame.click();
    const after = snap();
    frame.click();
    return { before, after, restored: snap() };
  });
  assert.equal(zoom.before.zoomed, false, 'expected the sample frame to start un-zoomed');
  assert.equal(zoom.after.zoomed, true, 'expected clicking the frame to zoom it');
  assert.equal(zoom.after.expanded, 'true', 'expected aria-expanded to track the zoom state');
  assert.ok(zoom.after.shown > zoom.before.shown,
    `expected zooming to widen the frame, got ${zoom.before.shown}px -> ${zoom.after.shown}px`);
  assert.deepEqual(zoom.after.buffers, zoom.before.buffers,
    `zooming must not resize the drawing buffers, got ${JSON.stringify(zoom.after.buffers)}`);
  assert.equal(zoom.restored.zoomed, false, 'expected a second click to collapse the frame');
  assert.equal(zoom.restored.expanded, 'false', 'expected aria-expanded to return to false');

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
