import { training, trainStart, trainStop, onTraining } from '../train/trainer.js';
import { PROFILES } from '../train/model.js';
import { dismissHint } from './input.js';

// ---------- train panel ----------
// One button and a live loss chart. The chart shows per-batch train loss
// (thin light line) with per-epoch val loss on top (cone orange) -- val
// drifting up while train keeps falling is overfitting made visible,
// same pedagogy-by-UI as the steering histogram above it.
const btn = document.getElementById('trainBtn');
const status = document.getElementById('trainStatus');
const progress = document.getElementById('trainProgress');
const chart = document.getElementById('lossChart');
const ctx = chart.getContext('2d');

// A phone run is slow enough that a batch every 20s is normal, so silence
// only becomes suspicious well past that.
const STALL_S = 45;

// iOS suspends a hidden page's timers AND its workers: switching apps or
// letting the screen lock stops training dead until you come back, with no
// event to say so. Worth naming, because the symptom -- a run that made no
// progress while you were away -- otherwise looks like a bug.
let hiddenWhileBusy = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (training.state === 'running' || training.state === 'loading') hiddenWhileBusy = true;
  } else {
    render();
  }
});

const CONE = '#ff6a2b';
const LIGHT = 'rgba(243,239,232,.5)';

// Phones get the small model and small batches by default. Both limits are
// about the same wall: a batch of 64 at 120x160 puts tens of MB of
// activations on the GPU at once, and a mobile GPU answers that by dropping
// the context or having the OS kill the worker -- training that goes quiet
// rather than failing. Desktop keeps the donkeycar-parity model.
const isPhone = matchMedia('(pointer:coarse)').matches;
const profileSelect = document.getElementById('trainProfile');
for (const [name, p] of Object.entries(PROFILES)) {
  profileSelect.add(new Option(p.label, name));
}
profileSelect.value = isPhone ? 'tiny' : 'linear';

btn.addEventListener('click', () => {
  dismissHint();
  if (training.state === 'running') trainStop();
  else {
    hiddenWhileBusy = false;
    trainStart({ profile: profileSelect.value, batchSize: isPhone ? 16 : 64 });
  }
});

function fmtDuration(s) {
  if (!Number.isFinite(s) || s <= 0) return '';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`;
}

function statusText() {
  switch (training.state) {
    case 'idle': return 'idle';
    case 'loading': return training.detail || 'loading';
    case 'running': {
      const cur = Math.min(training.epoch + 1, training.epochsTotal);
      // The backend is the single most useful word here: 'cpu' means tfjs
      // found no usable GPU path and the run will be ~100x slower, which is
      // most of the "why is this taking so long" cases on a phone.
      const backend = training.backend === 'cpu' ? 'cpu (no gpu)' : training.backend;
      return `${backend} · epoch ${cur}/${training.epochsTotal}`;
    }
    case 'done': {
      const last = training.epochLog[training.epochLog.length - 1];
      const val = last && Number.isFinite(last.valLoss) ? `val ${last.valLoss.toFixed(3)} · ` : '';
      return `${val}${Math.round(training.elapsed)}s${training.stopped ? ' · stopped' : ''}`;
    }
    case 'error': return training.error || 'error';
  }
}

// The "is it actually moving?" line. A loss chart that gains a pixel a
// minute cannot answer that, and neither can an epoch counter that only
// ticks once every few minutes.
function progressText() {
  const busy = training.state === 'loading' || training.state === 'running';
  if (!busy) return { text: '', warn: false };

  if (training.quietFor >= STALL_S) {
    const secs = Math.round(training.quietFor);
    return {
      warn: true,
      text: hiddenWhileBusy
        ? `no progress for ${fmtDuration(secs)} — this device pauses training whenever the tab is hidden or the screen is off; keep this page open and awake`
        : `no progress for ${fmtDuration(secs)} — the training worker has gone quiet (out of memory, or the browser suspended it)`,
    };
  }

  if (training.state === 'loading') return { text: training.detail || 'starting', warn: false };

  const done = training.batchLosses.length;
  if (!done && training.phase) return { text: training.phase, warn: false };

  const parts = [];
  if (training.batchesTotal) parts.push(`batch ${done}/${training.batchesTotal}`);
  if (training.batchesPerSec > 0) {
    parts.push(training.batchesPerSec >= 1
      ? `${training.batchesPerSec.toFixed(1)} batch/s`
      : `${(1 / training.batchesPerSec).toFixed(1)}s per batch`);
    const left = (training.batchesTotal - done) / training.batchesPerSec;
    if (training.batchesTotal > done) parts.push(`~${fmtDuration(left)} left`);
  }
  return { text: parts.join(' · '), warn: false };
}

function render() {
  status.textContent = statusText();
  status.title = training.state === 'error' ? (training.error || '') : '';
  const p = progressText();
  progress.textContent = p.text;
  progress.classList.toggle('warn', p.warn);
  const busy = training.state === 'loading' || training.state === 'running';
  btn.textContent = training.state === 'running' ? 'stop'
    : training.state === 'done' ? 'retrain'
    : 'train model';
  btn.disabled = training.state === 'loading';
  profileSelect.disabled = busy;
  btn.classList.toggle('running', busy);
  drawChart();
}

// Log-scale y: the first batches' loss dwarfs everything after, and a
// linear axis would flatten the entire interesting tail into one pixel.
function drawChart() {
  const w = chart.width, h = chart.height;
  ctx.clearRect(0, 0, w, h);
  const bl = training.batchLosses;
  const el = training.epochLog;
  if (bl.length < 2) return;

  let lo = Infinity, hi = -Infinity;
  for (const v of bl) if (Number.isFinite(v) && v > 0) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (const e of el) { const v = e.valLoss; if (Number.isFinite(v) && v > 0) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (!Number.isFinite(lo)) return;
  const llo = Math.log10(lo);
  const span = Math.max(Math.log10(hi) - llo, 1e-3);
  const X = (i) => (i / Math.max(bl.length - 1, 1)) * (w - 2) + 1;
  const Y = (v) => h - 2 - ((Math.log10(Math.max(v, 1e-8)) - llo) / span) * (h - 4);

  ctx.strokeStyle = LIGHT;
  ctx.lineWidth = 1;
  ctx.beginPath();
  bl.forEach((v, i) => { if (i) ctx.lineTo(X(i), Y(v)); else ctx.moveTo(X(i), Y(v)); });
  ctx.stroke();

  const ex = (e) => X(Math.min(e.atBatch - 1, bl.length - 1));
  ctx.strokeStyle = CONE;
  ctx.fillStyle = CONE;
  if (el.length > 1) {
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    el.forEach((e, i) => { if (i) ctx.lineTo(ex(e), Y(e.valLoss)); else ctx.moveTo(ex(e), Y(e.valLoss)); });
    ctx.stroke();
  }
  for (const e of el) {
    ctx.beginPath();
    ctx.arc(ex(e), Y(e.valLoss), 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

onTraining(render);
render();
