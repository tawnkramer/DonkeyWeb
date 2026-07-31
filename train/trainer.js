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
  epochLog: [],      // { epoch, loss, valLoss, atBatch }
  elapsed: 0,
  stopped: false,
  error: null,
};

const listeners = new Set();
export function onTraining(fn) { listeners.add(fn); }
function emit() { for (const fn of listeners) fn(training); }

let worker = null;

function onMessage({ data: m }) {
  switch (m.type) {
    case 'status':
      training.state = 'loading';
      training.detail = m.detail;
      break;
    case 'backend':
      training.backend = m.backend;
      break;
    case 'dataset':
      training.state = 'running';
      training.nTrain = m.nTrain;
      training.nVal = m.nVal;
      training.epochsTotal = m.epochs;
      break;
    case 'batch':
      training.batchLosses.push(m.loss);
      break;
    case 'epoch':
      training.epoch = m.epoch;
      training.epochLog.push({ epoch: m.epoch, loss: m.loss, valLoss: m.valLoss, atBatch: m.atBatch });
      break;
    case 'done':
      training.state = 'done';
      training.elapsed = m.elapsed;
      training.stopped = m.stopped;
      break;
    case 'error':
      training.state = 'error';
      training.error = m.error;
      console.error('training:', m.error);
      break;
  }
  emit();
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
    batchLosses: [], epochLog: [], elapsed: 0, stopped: false, error: null,
  });
  emit();
  ensureWorker().postMessage({ type: 'start', ...opts });
}

export function trainStop() {
  if (worker && training.state === 'running') worker.postMessage({ type: 'stop' });
}
