// Training runs in this module worker so the sim's render loop never
// janks (plan §2.3). Workers share the origin's IndexedDB, so the tub is
// read directly here via the same data/db.js the recorder uses -- no need
// to ship megabytes of JPEG blobs through postMessage.
import * as tf from '../vendor/tf.mjs';
import { dbGetAll } from '../data/db.js';
import { buildModel } from './model.js';

const MODEL_URL = 'indexeddb://donkeyweb-model';
const W = 160, H = 120, C = 3;
// Below ~50 frames (2.5s of driving) even a smoke-test train is
// meaningless; refuse with a message the UI can show verbatim.
const MIN_FRAMES = 50;

let running = false;
let stopRequested = false;

function post(msg) { self.postMessage(msg); }

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

// Decode every stored JPEG once into a single uint8 [n,H,W,C] buffer
// (~5-8 KB/frame on disk becomes 57.6 KB/frame raw: 5k frames ~ 288 MB,
// acceptable; the same data as float32 would be 1.15 GB, which is not --
// so batches are converted to float on the backend per-step instead).
async function decodeAll(records) {
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const n = records.length;
  const imgs = new Uint8Array(n * H * W * C);
  const labels = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const bmp = await createImageBitmap(records[i].img);
    ctx.drawImage(bmp, 0, 0, W, H);
    bmp.close();
    const rgba = ctx.getImageData(0, 0, W, H).data;
    let dst = i * H * W * C;
    for (let p = 0; p < rgba.length; p += 4) {
      imgs[dst++] = rgba[p];
      imgs[dst++] = rgba[p + 1];
      imgs[dst++] = rgba[p + 2];
    }
    labels[i * 2] = records[i].steer;
    labels[i * 2 + 1] = records[i].throttle;
    if (i % 100 === 0) post({ type: 'status', phase: 'loading', detail: `decoding ${i}/${n}` });
  }
  return { imgs, labels };
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Builds one training batch as tensors. Augmentation is a random
// horizontal flip with steering negation (plan §2.3's "cheap, big win"):
// it doubles the effective dataset and exactly balances the left/right
// steering distribution, done on the uint8 buffer while assembling the
// batch so no extra GPU pass is needed.
function makeBatch(tf_, imgs, labels, indices, augment) {
  const bs = indices.length;
  const px = new Uint8Array(bs * H * W * C);
  const steer = new Float32Array(bs);
  const throt = new Float32Array(bs);
  for (let b = 0; b < bs; b++) {
    const i = indices[b];
    const src = i * H * W * C;
    const dst = b * H * W * C;
    const flip = augment && Math.random() < 0.5;
    if (!flip) {
      px.set(imgs.subarray(src, src + H * W * C), dst);
    } else {
      for (let y = 0; y < H; y++) {
        const rs = src + y * W * C;
        const rd = dst + y * W * C;
        for (let x = 0; x < W; x++) {
          const s = rs + (W - 1 - x) * C;
          const d = rd + x * C;
          px[d] = imgs[s]; px[d + 1] = imgs[s + 1]; px[d + 2] = imgs[s + 2];
        }
      }
    }
    steer[b] = flip ? -labels[i * 2] : labels[i * 2];
    throt[b] = labels[i * 2 + 1];
  }
  return tf_.tidy(() => ({
    xs: tf_.tensor4d(px, [bs, H, W, C]).div(255),
    ys: {
      n_outputs0: tf_.tensor2d(steer, [bs, 1]),
      n_outputs1: tf_.tensor2d(throt, [bs, 1]),
    },
  }));
}

async function run({ epochs = 10, batchSize = 64, valFrac = 0.15 }) {
  const t0 = performance.now();
  post({ type: 'status', phase: 'loading', detail: 'starting backend' });
  await chooseBackend();
  post({ type: 'backend', backend: tf.getBackend() });

  post({ type: 'status', phase: 'loading', detail: 'reading tub' });
  const records = await dbGetAll();
  if (records.length < MIN_FRAMES) {
    throw new Error(`need ${MIN_FRAMES}+ frames to train (have ${records.length}) -- drive a few laps first`);
  }
  const { imgs, labels } = await decodeAll(records);

  // Shuffle once, then split -- consecutive 20 Hz frames are nearly
  // identical, so a tail-of-recording val split would score whatever the
  // driver happened to be doing last rather than general performance.
  const order = shuffleInPlace([...records.keys()]);
  const nVal = Math.max(1, Math.round(records.length * valFrac));
  const valIdx = order.slice(0, nVal);
  const trainIdx = order.slice(nVal);
  post({ type: 'dataset', nTrain: trainIdx.length, nVal, epochs, batchSize });

  const trainDs = tf.data.generator(function* () {
    const epochOrder = shuffleInPlace(trainIdx.slice());
    for (let s = 0; s < epochOrder.length; s += batchSize) {
      yield makeBatch(tf, imgs, labels, epochOrder.slice(s, s + batchSize), true);
    }
  });
  const valDs = tf.data.generator(function* () {
    for (let s = 0; s < valIdx.length; s += batchSize) {
      yield makeBatch(tf, imgs, labels, valIdx.slice(s, s + batchSize), false);
    }
  });

  const model = buildModel(tf);
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
          post({ type: 'epoch', epoch: epoch + 1, loss: logs.loss, valLoss: logs.val_loss, atBatch: batchNum });
          if (stopRequested) model.stopTraining = true;
        },
      },
    });

    // Saved even when stopped early -- the early-stop button means "good
    // enough, let me try it", not "throw it away".
    await model.save(MODEL_URL);
  } finally {
    model.dispose();
  }
  post({ type: 'done', elapsed: (performance.now() - t0) / 1000, stopped: stopRequested });
}
