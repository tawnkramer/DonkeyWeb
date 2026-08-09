// Training runs in this module worker so the sim's render loop never
// janks (plan §2.3). Workers share the origin's IndexedDB, so the tub is
// read directly here via the same data/db.js the recorder uses -- no need
// to ship megabytes of image blobs through postMessage.
import * as tf from '../vendor/tf.mjs';
import { dbGetAll } from '../data/db.js';
import { buildModel, PROFILES, DEFAULT_PROFILE } from './model.js';

const LEGACY_MODEL_URL = 'indexeddb://donkeyweb-model';
const C = 3;
// Below ~50 frames (2.5s of driving) even a smoke-test train is
// meaningless; refuse with a message the UI can show verbatim.
const MIN_FRAMES = 50;
// The cpu backend runs one batch as a single uninterruptible chunk of JS,
// and this net costs roughly 9 GMACs per batch of 64 -- minutes of dead
// silence on a phone, which is indistinguishable from a crash. A smaller
// batch does the same total work but reports in four times as often, so
// "slow" at least looks different from "dead".
const CPU_BATCH = 16;

let running = false;
let stopRequested = false;

function post(msg, transfer) { self.postMessage(msg, transfer); }

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'start') {
    if (running) return;
    running = true;
    stopRequested = false;
    run(msg)
      .catch((err) => post({ type: 'error', error: String((err && err.message) || err) }))
      .finally(() => { running = false; });
  } else if (msg.type === 'stop') {
    stopRequested = true;
  }
};

// WebGPU is progressive enhancement, WebGL the tested default (plan §5).
// The wasm backend is deliberately skipped: it's missing gradient kernels
// for conv layers, so it fails mid-fit rather than at setBackend, which is
// worse than the slow-but-complete cpu backend as the last resort.
async function chooseBackend() {
  if (self.navigator && self.navigator.gpu) {
    try {
      if (await tf.setBackend('webgpu')) { await tf.ready(); return; }
    } catch { /* fall through */ }
  }
  try {
    if (await tf.setBackend('webgl')) { await tf.ready(); return; }
  } catch { /* fall through */ }
  await tf.setBackend('cpu');
  await tf.ready();
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Frames are decoded a batch at a time rather than all at once up front.
// The old approach kept every frame decoded in one uint8 [n,H,W,C] buffer
// -- 57.6 KB per frame, so 1200 frames is a 69 MB allocation that a phone's
// worker heap may simply refuse (iOS kills the worker with no event, which
// looks exactly like a hang). Decoding per batch caps live pixel memory at
// one batch and starts training immediately instead of after a long silent
// decode pass; the cost is re-decoding each frame once per epoch, which is
// milliseconds against a batch step.
// Sized to the model's input, not the recorded frame: drawImage does the
// downscale on the way in, so a 64x64 profile never materializes a
// full-resolution batch anywhere.
let W = PROFILES[DEFAULT_PROFILE].w, H = PROFILES[DEFAULT_PROFILE].h;
let decodeCanvas = null, decodeCtx = null;

function setInputSize(w, h) {
  W = w; H = h;
  decodeCanvas = new OffscreenCanvas(W, H);
  decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true });
}

// Augmentation is a random horizontal flip with steering negation (plan
// §2.3's "cheap, big win"): it doubles the effective dataset and exactly
// balances the left/right steering distribution. Flipping via the canvas
// transform makes it free -- the draw has to happen anyway.
async function decodeFrame(blob, flip) {
  const bmp = await createImageBitmap(blob);
  decodeCtx.setTransform(flip ? -1 : 1, 0, 0, 1, flip ? W : 0, 0);
  decodeCtx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  return decodeCtx.getImageData(0, 0, W, H).data;
}

async function* batchesOf(records, indices, batchSize, augment) {
  for (let s = 0; s < indices.length; s += batchSize) {
    const idx = indices.slice(s, s + batchSize);
    const bs = idx.length;
    const px = new Uint8Array(bs * H * W * C);
    const steer = new Float32Array(bs);
    const throt = new Float32Array(bs);
    for (let b = 0; b < bs; b++) {
      const rec = records[idx[b]];
      const flip = augment && Math.random() < 0.5;
      const rgba = await decodeFrame(rec.img, flip);
      let dst = b * H * W * C;
      for (let p = 0; p < rgba.length; p += 4) {
        px[dst++] = rgba[p];
        px[dst++] = rgba[p + 1];
        px[dst++] = rgba[p + 2];
      }
      steer[b] = flip ? -rec.steer : rec.steer;
      throt[b] = rec.throttle;
    }
    yield tf.tidy(() => ({
      xs: tf.tensor4d(px, [bs, H, W, C]).div(255),
      ys: {
        n_outputs0: tf.tensor2d(steer, [bs, 1]),
        n_outputs1: tf.tensor2d(throt, [bs, 1]),
      },
    }));
  }
}

// Keep one stable, readable window for the UI. It is sampled from the
// training split (not validation) and re-predicted after every epoch so the
// overlay shows the model learning the same examples over time. targets/
// predictions are steering (what the chart plots); the throttle arrays ride
// along for the single-frame readout in the sample panel, index-aligned
// with the same unshuffled `indices` order so index 0 is always the same
// recorded frame across epochs.
async function steeringSlice(model, records, indices) {
  const iterator = batchesOf(records, indices, indices.length, false);
  const { value } = await iterator.next();
  const prediction = model.predict(value.xs);
  const predictedSteer = Array.from(await prediction[0].data());
  const predictedThrottle = Array.from(await prediction[1].data());
  const targetSteer = Array.from(await value.ys.n_outputs0.data());
  const targetThrottle = Array.from(await value.ys.n_outputs1.data());
  value.xs.dispose();
  value.ys.n_outputs0.dispose();
  value.ys.n_outputs1.dispose();
  prediction[0].dispose();
  prediction[1].dispose();
  return { targets: targetSteer, predictions: predictedSteer, targetThrottle, predictedThrottle };
}

// Decodes the same single frame steeringSlice used for index 0 (unaugmented,
// at model input resolution) and hands back a transferable bitmap -- "this
// is exactly what the network saw" is the point, so no resizing beyond what
// the model itself takes as input.
async function sampleFrameBitmap(records, idx) {
  await decodeFrame(records[idx].img, false);
  return createImageBitmap(decodeCanvas);
}

async function run({ epochs = 10, batchSize = 64, valFrac = 0.15, profile = DEFAULT_PROFILE, modelUrl = LEGACY_MODEL_URL }) {
  const t0 = performance.now();
  post({ type: 'status', phase: 'loading', detail: 'starting backend' });
  await chooseBackend();
  const backend = tf.getBackend();
  if (backend === 'cpu' && batchSize > CPU_BATCH) batchSize = CPU_BATCH;
  const shape = PROFILES[profile] || PROFILES[DEFAULT_PROFILE];
  setInputSize(shape.w, shape.h);
  post({ type: 'backend', backend, batchSize, profile });

  post({ type: 'status', phase: 'loading', detail: 'reading tub' });
  const records = await dbGetAll();
  if (records.length < MIN_FRAMES) {
    throw new Error(`need ${MIN_FRAMES}+ frames to train (have ${records.length}) -- drive a few laps first`);
  }

  // Shuffle once, then split -- consecutive 20 Hz frames are nearly
  // identical, so a tail-of-recording val split would score whatever the
  // driver happened to be doing last rather than general performance.
  const order = shuffleInPlace([...records.keys()]);
  const nVal = Math.max(1, Math.round(records.length * valFrac));
  const valIdx = order.slice(0, nVal);
  const trainIdx = order.slice(nVal);
  const previewIdx = trainIdx.slice(0, Math.min(100, trainIdx.length));
  post({ type: 'dataset', nTrain: trainIdx.length, nVal, epochs, batchSize });

  const trainDs = tf.data.generator(
    () => batchesOf(records, shuffleInPlace(trainIdx.slice()), batchSize, true));
  const valDs = tf.data.generator(
    () => batchesOf(records, valIdx, batchSize, false));

  // Named phases from here on: everything between 'dataset' and the first
  // batch callback is one silent stretch, and on a slow device it is long
  // enough (kernel compilation, first tensor uploads) to look like a hang.
  post({ type: 'phase', phase: 'building the model' });
  const model = buildModel(tf, profile);
  post({ type: 'phase', phase: `warming up ${backend} — first batch is the slow one` });
  let batchNum = 0;
  try {
    await model.fitDataset(trainDs, {
      epochs,
      validationData: valDs,
      callbacks: {
        onBatchEnd: async (_batch, logs) => {
          batchNum++;
          post({ type: 'batch', batch: batchNum, loss: logs.loss });
          if (stopRequested) model.stopTraining = true;
        },
        onEpochEnd: async (epoch, logs) => {
          const valAccuracy = logs.val_n_outputs0_toleranceAccuracy;
          const slice = await steeringSlice(model, records, previewIdx);
          slice.epoch = epoch + 1;
          const bitmap = await sampleFrameBitmap(records, previewIdx[0]);
          const sample = {
            target: { steer: slice.targets[0], throttle: slice.targetThrottle[0] },
            prediction: { steer: slice.predictions[0], throttle: slice.predictedThrottle[0] },
            bitmap,
          };
          post({ type: 'epoch', epoch: epoch + 1, loss: logs.loss, valLoss: logs.val_loss, valAccuracy, atBatch: batchNum, steeringSlice: slice, sample }, [bitmap]);
          if (stopRequested) model.stopTraining = true;
        },
      },
    });

    // Saved even when stopped early -- the early-stop button means "good
    // enough, let me try it", not "throw it away".
    await model.save(modelUrl);
  } finally {
    model.dispose();
  }
  post({ type: 'done', elapsed: (performance.now() - t0) / 1000, stopped: stopRequested });
}
