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
// Survives the end of run() so the frame slider still works after training
// finishes -- which is when you actually sit and read saliency maps, rather
// than while the numbers are still moving.
let session = null; // { model, byId: Map<id, record> }
// Which recorded frame the panel is on, by tub id rather than by position:
// the UI picks it from tub.frames while this worker reads IndexedDB, and
// nothing guarantees those two lists stay index-aligned through a trim.
let sampleId = null;

// The model outlives its run, so something has to end it: the next run does,
// just before it builds its replacement. Deferring it this way costs one
// model's worth of resident weights between runs -- far less than the fit
// that just finished, which held those weights plus a batch of activations.
function releaseSession() {
  if (session) session.model.dispose();
  session = null;
}

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
  } else if (msg.type === 'sample') {
    // While a fit is in flight the new frame is only recorded: a gradient
    // pass fired from a message handler would land in the middle of a batch,
    // unlike the epoch-end one, which runs at a point where fit is already
    // parked awaiting its callback. The next epoch picks it up.
    sampleId = msg.id;
    if (!running) sendSample();
  }
};

// Rising id for on-demand requests, so work for a frame the user has already
// scrubbed past can be abandoned instead of queueing up behind the thumb.
// Every await below is a chance for a newer request to land.
let sampleSeq = 0;

// What the worker owes the sample panel, deliberately in two posts. The
// picture is not among them: the page draws that itself, straight out of the
// tub, so scrubbing never waits on this worker at all. What it cannot do
// without a model is say what the network predicts and where it was looking,
// and those two differ by three orders of magnitude in cost -- a single
// forward pass against two full gradient passes over the network. So the
// prediction goes out immediately and the maps follow when they are ready.
//
// Errors are swallowed to a console message rather than the 'error' channel:
// failing to explain one frame is not a failed training run, and must not
// tear down a model you just spent three minutes on.
async function sendSample() {
  if (!session) return;
  const rec = session.byId.get(sampleId);
  if (!rec) return;
  const seq = ++sampleSeq;
  const id = sampleId;
  let x = null;
  try {
    x = await decodeSample(rec);
    if (seq !== sampleSeq) return; // scrubbed past while decoding
    post({ type: 'sample', id, prediction: predictOne(session.model, x) });
    const saliency = await saliencyMaps(session.model, x);
    if (seq !== sampleSeq) return;
    post({ type: 'saliency', id, saliency, w: W, h: H },
      [saliency.steer.buffer, saliency.throttle.buffer]);
  } catch (err) {
    console.error('sample frame:', err);
  } finally {
    if (x) x.dispose();
  }
}

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

// Vanilla gradient saliency: d(output)/d(input pixel), absolute value, maxed
// over the three colour channels. It answers "which pixels would move this
// number most if they changed", which is the question actually worth asking
// of a behaviour-cloned driver -- a model can reach a good loss by reading
// the wrong thing (the hood, a scenery landmark that happens to correlate
// with a corner) and the loss curve cannot tell you that. For the city
// specifically: a throttle head that brakes at a red light but has all its
// gradient on the road surface rather than the signal has learned a
// coincidence, and will not transfer to a light in a different place.
//
// model.apply rather than model.predict -- predict runs the forward pass
// without a gradient tape, so tf.grad through it yields nothing. Dropout is
// forced off so the map describes the deployed network, not one random
// thinned copy of it.
function saliencyFor(model, x, head) {
  return tf.tidy(() => {
    const grads = tf.grad(inp => model.apply(inp, { training: false })[head].sum())(x);
    return grads.abs().max(3).squeeze([0]);
  });
}

// Scaled against the 99th percentile rather than the max. These maps
// reliably contain a few blown-out pixels, and dividing by the largest of
// them flattens the entire rest of the image to invisible; anything above
// the percentile just clamps. Quantised to bytes because it is a heatmap --
// 8 bits is well past what the eye resolves here, and it halves what
// crosses the postMessage boundary every epoch.
function normalizeSaliency(values) {
  const sorted = Float32Array.from(values).sort();
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || sorted[sorted.length - 1];
  const out = new Uint8Array(values.length);
  if (!(p99 > 0)) return out; // an all-zero gradient (dead net) stays all-zero
  for (let i = 0; i < values.length; i++) {
    out[i] = Math.min(255, Math.round((values[i] / p99) * 255));
  }
  return out;
}

// Which frame to open on when the page has not already chosen one. A frame
// where the car is barely turning contains no decision worth explaining, and
// on a mostly-straight track an arbitrary frame is usually one of those --
// which is what made the first version of this panel easy to dismiss. The
// sharpest turn is where the model is committing to something, so it is where
// a wrong reason shows up most clearly. Steering is recorded data, so this is
// fixed for the run and the frame does not move under you between epochs.
function pickSampleId(records) {
  let best = null, bestAbs = -1;
  for (const rec of records) {
    const abs = Math.abs(rec.steer);
    if (abs > bestAbs) { bestAbs = abs; best = rec.id; }
  }
  return best;
}

// Decodes one frame (unaugmented, at model input resolution) into the input
// tensor -- "this is exactly what the network saw" is the point, so no
// resizing beyond what the model itself takes as input. The page decodes the
// same frame to the same size for display, which is what keeps the heatmap
// registered pixel-for-pixel with the picture under it. Caller disposes.
async function decodeSample(rec) {
  const rgba = await decodeFrame(rec.img, false);
  const px = new Uint8Array(H * W * C);
  let dst = 0;
  for (let p = 0; p < rgba.length; p += 4) {
    px[dst++] = rgba[p];
    px[dst++] = rgba[p + 1];
    px[dst++] = rgba[p + 2];
  }
  return tf.tidy(() => tf.tensor4d(px, [1, H, W, C]).div(255));
}

// Read here rather than borrowed from steeringSlice, so the slider can serve
// any frame once fit has returned and there is no live slice left to index.
function predictOne(model, x) {
  const [steer, throttle] = tf.tidy(() => {
    const out = model.predict(x);
    return [out[0].dataSync()[0], out[1].dataSync()[0]];
  });
  return { steer, throttle };
}

// The expensive half: two gradient passes over the whole network.
async function saliencyMaps(model, x) {
  const steerMap = saliencyFor(model, x, 0);
  const throttleMap = saliencyFor(model, x, 1);
  const [steerVals, throttleVals] = await Promise.all([steerMap.data(), throttleMap.data()]);
  steerMap.dispose();
  throttleMap.dispose();
  return { steer: normalizeSaliency(steerVals), throttle: normalizeSaliency(throttleVals) };
}

// The epoch-end path, where staging the two halves would buy nothing -- the
// panel is already only updating once per epoch, and the maps are ready
// before anyone could have reacted to the prediction.
async function buildSample(model, rec) {
  const x = await decodeSample(rec);
  try {
    return {
      id: rec.id,
      prediction: predictOne(model, x),
      saliency: await saliencyMaps(model, x),
      w: W, h: H, // the maps' own grid, which need not match the displayed frame
    };
  } finally {
    x.dispose();
  }
}

async function run({ epochs = 10, batchSize = 64, valFrac = 0.15, profile = DEFAULT_PROFILE, modelUrl = LEGACY_MODEL_URL, sampleId: wantSampleId = null }) {
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
  const byId = new Map(records.map((r) => [r.id, r]));
  // The page has usually already picked a frame by scrubbing before pressing
  // train, and that choice outranks this worker's guess -- but it is checked
  // against the tub rather than trusted, since a frame can be trimmed away
  // between the pick and the run.
  sampleId = byId.has(wantSampleId) ? wantSampleId : pickSampleId(records);
  post({ type: 'dataset', nTrain: trainIdx.length, nVal, epochs, batchSize });

  const trainDs = tf.data.generator(
    () => batchesOf(records, shuffleInPlace(trainIdx.slice()), batchSize, true));
  const valDs = tf.data.generator(
    () => batchesOf(records, valIdx, batchSize, false));

  // Named phases from here on: everything between 'dataset' and the first
  // batch callback is one silent stretch, and on a slow device it is long
  // enough (kernel compilation, first tensor uploads) to look like a hang.
  post({ type: 'phase', phase: 'building the model' });
  releaseSession(); // the previous run's model has outlived its usefulness now
  const model = buildModel(tf, profile);
  session = { model, byId };
  post({ type: 'phase', phase: `warming up ${backend} — first batch is the slow one` });
  let batchNum = 0;
  // The model is deliberately not disposed when this returns: the frame
  // slider keeps predicting and taking gradients through it afterwards, and
  // reading saliency maps is something you do once the numbers have stopped
  // moving. releaseSession() above ends the previous run's model instead, so
  // a run that threw is cleaned up on the next attempt rather than leaking.
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
        const sample = await buildSample(model, byId.get(sampleId));
        post({ type: 'epoch', epoch: epoch + 1, loss: logs.loss, valLoss: logs.val_loss, valAccuracy, atBatch: batchNum, steeringSlice: slice, sample },
          [sample.saliency.steer.buffer, sample.saliency.throttle.buffer]);
        if (stopRequested) model.stopTraining = true;
      },
    },
  });

  // Saved even when stopped early -- the early-stop button means "good
  // enough, let me try it", not "throw it away".
  await model.save(modelUrl);
  post({ type: 'done', elapsed: (performance.now() - t0) / 1000, stopped: stopRequested });
}
