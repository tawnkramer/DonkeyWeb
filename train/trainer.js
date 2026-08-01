// Main-thread controller for the training worker: owns the worker
// lifecycle and mirrors its progress messages into a plain `training`
// state object that the HUD renders from (and tests assert on via
// window.__sim). All tfjs lives in the worker; this file is DOM- and
// tfjs-free on purpose.

export const training = {
  state: 'idle', // idle | loading | running | done | error
  detail: '',    // human-readable sub-status while loading
  backend: null,
  epoch: 0,      // completed epochs
  epochsTotal: 0,
  nTrain: 0,
  nVal: 0,
  batchLosses: [],   // one entry per training batch, across all epochs
  epochLog: [],      // { epoch, loss, valLoss, valAccuracy, atBatch }
  valAccuracy: null,
  steeringSlice: null, // { epoch, targets, predictions } for the train UI
  elapsed: 0,
  stopped: false,
  error: null,
  // Progress, in units a human can act on. A phone can be an order of
  // magnitude slower than the laptop this was written on -- slow enough that
  // "epoch 1/10" alone is indistinguishable from a hang, which is exactly the
  // question you have when watching it. batchesTotal/ETA answer "is it
  // moving?", quietFor answers "has it stopped?".
  batchesTotal: 0,
  batchesPerSec: 0,
  quietFor: 0,       // seconds since the worker last said anything
  phase: '',         // what the worker is doing before the first batch lands
  modelId: null,
  modelUrl: null,
};

const listeners = new Set();
export function onTraining(fn) { listeners.add(fn); }
function emit() { for (const fn of listeners) fn(training); }

let worker = null;

// A silent worker is the one failure this cannot ask about: iOS kills a
// worker that runs out of memory without firing onerror, so the only
// evidence is that the messages stop. Tracked here and rendered as
// "no progress for Ns" rather than a status line frozen mid-count.
let lastMsgAt = 0;
let ticker = null;
// Rate over a trailing window, not the whole run: the first batches include
// backend warm-up and shader compilation, which would drag a run-long
// average (and its ETA) far off for the rest of the run.
let recentBatchAt = [];
const RATE_WINDOW = 20;

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    training.quietFor = (performance.now() - lastMsgAt) / 1000;
    emit();
  }, 1000);
}

function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
  training.quietFor = 0;
}

function onMessage({ data: m }) {
  lastMsgAt = performance.now();
  training.quietFor = 0;
  switch (m.type) {
    case 'status':
      training.state = 'loading';
      training.detail = m.detail;
      break;
    case 'backend':
      training.backend = m.backend;
      break;
    // What the worker is doing between 'dataset' and the first batch --
    // kernel compilation and the first tensor uploads, which on a slow
    // device is a long silence that reads as a hang.
    case 'phase':
      training.phase = m.phase;
      break;
    case 'dataset':
      training.state = 'running';
      training.nTrain = m.nTrain;
      training.nVal = m.nVal;
      training.epochsTotal = m.epochs;
      training.batchesTotal = Math.ceil(m.nTrain / m.batchSize) * m.epochs;
      break;
    case 'batch': {
      training.batchLosses.push(m.loss);
      recentBatchAt.push(lastMsgAt);
      if (recentBatchAt.length > RATE_WINDOW) recentBatchAt.shift();
      const span = recentBatchAt[recentBatchAt.length - 1] - recentBatchAt[0];
      training.batchesPerSec = span > 0 ? (recentBatchAt.length - 1) / (span / 1000) : 0;
      break;
    }
    case 'epoch':
      training.epoch = m.epoch;
      training.valAccuracy = m.valAccuracy;
      training.steeringSlice = m.steeringSlice || null;
      training.epochLog.push({ epoch: m.epoch, loss: m.loss, valLoss: m.valLoss, valAccuracy: m.valAccuracy, atBatch: m.atBatch });
      break;
    case 'done':
      training.state = 'done';
      training.elapsed = m.elapsed;
      training.stopped = m.stopped;
      stopTicker();
      dropWorkerIfDegraded();
      break;
    case 'error':
      training.state = 'error';
      training.error = m.error;
      console.error('training:', m.error);
      stopTicker();
      dropWorkerIfDegraded();
      break;
  }
  emit();
}

// tfjs unregisters a backend whose initialization failed, so an instance
// that once fell back to cpu will never try the GPU again -- and the usual
// reason for that fallback (no WebGL context to spare) is temporary and is
// exactly what the Train tab's GPU release frees up. Keeping a cpu worker
// alive would make one bad first attempt permanent for the session, so it is
// thrown away and the next run gets a fresh tfjs.
function dropWorkerIfDegraded() {
  if (worker && training.backend === 'cpu') {
    worker.terminate();
    worker = null;
  }
}

// The worker is kept alive between runs: a retrain then skips re-fetching
// tfjs from the CDN and re-initializing the GPU backend, which is most of
// the latency on the plan's "collect more data, retrain" loop.
function ensureWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onMessage;
    worker.onerror = (e) => {
      training.state = 'error';
      training.error = e.message || 'training worker failed to load';
      console.error('training worker:', e);
      stopTicker();
      emit();
      // A load-level failure (e.g. CDN unreachable) leaves the worker
      // useless; drop it so the next attempt starts fresh.
      worker.terminate();
      worker = null;
    };
  }
  return worker;
}

export function trainStart(opts = {}) {
  if (training.state === 'loading' || training.state === 'running') return;
  Object.assign(training, {
    state: 'loading', detail: 'starting', backend: training.backend,
    epoch: 0, epochsTotal: 0, nTrain: 0, nVal: 0,
    batchLosses: [], epochLog: [], valAccuracy: null, steeringSlice: null, elapsed: 0, stopped: false, error: null,
    batchesTotal: 0, batchesPerSec: 0, quietFor: 0, phase: '',
    modelId: opts.modelId || null, modelUrl: opts.modelUrl || null,
  });
  recentBatchAt = [];
  lastMsgAt = performance.now();
  startTicker();
  emit();
  ensureWorker().postMessage({ type: 'start', ...opts });
}

export function trainStop() {
  if (worker && training.state === 'running') worker.postMessage({ type: 'stop' });
}
