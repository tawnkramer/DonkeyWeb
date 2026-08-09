import { training, trainStart, trainStop, onTraining } from '../train/trainer.js';
import { PROFILES } from '../train/model.js';
import { createUserModel, modelStorageKey, setActiveModelId } from '../train/models.js';
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
const steeringChart = document.getElementById('steeringChart');
const steeringCtx = steeringChart.getContext('2d');
const batchLossValue = document.getElementById('batchLossValue');
const avgLossValue = document.getElementById('avgLossValue');
const valLossValue = document.getElementById('valLossValue');
const valAccuracyValue = document.getElementById('valAccuracyValue');
const sampleWrap = document.getElementById('trainSample');
const sampleEpochTag = document.getElementById('sampleEpochTag');
const sampleCanvas = document.getElementById('sampleCanvas');
const sampleCtx = sampleCanvas.getContext('2d');
const sampleSteerTarget = document.getElementById('sampleSteerTarget');
const sampleSteerPred = document.getElementById('sampleSteerPred');
const sampleSteerErr = document.getElementById('sampleSteerErr');
const sampleThrottleTarget = document.getElementById('sampleThrottleTarget');
const sampleThrottlePred = document.getElementById('sampleThrottlePred');
const sampleThrottleErr = document.getElementById('sampleThrottleErr');

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
const AXIS = 'rgba(243,239,232,.38)';
const LABEL = 'rgba(243,239,232,.68)';

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

btn.addEventListener('click', async () => {
  dismissHint();
  if (training.state === 'running') trainStop();
  else {
    hiddenWhileBusy = false;
    const profile = profileSelect.value;
    const model = await createUserModel({
      name: `Trained ${profile} model`,
      source: 'trained',
      profile,
      input: `${PROFILES[profile].w}×${PROFILES[profile].h}`,
    });
    setActiveModelId(model.id);
    trainStart({
      profile,
      batchSize: isPhone ? 16 : 64,
      modelId: model.id,
      modelUrl: modelStorageKey(model.id),
    });
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
  renderMetrics();
  drawChart();
  drawSteeringChart();
  drawSample();
}

function formatLoss(value) {
  return Number.isFinite(value) ? value.toFixed(4) : '—';
}

function formatSigned(value) {
  return Number.isFinite(value) ? value.toFixed(3) : '—';
}

// The same frame steeringChart already plots at index 0 -- here as actual
// pixels (exactly what the model's forward pass received) next to the
// recorded/predicted/error numbers, so "the network is wrong here" has a
// picture to point at instead of just a gap between two lines.
function drawSample() {
  const sample = training.sample;
  sampleWrap.hidden = !sample;
  if (!sample) return;
  const { bitmap, target, prediction } = sample;
  const maxW = 160;
  const scale = maxW / bitmap.width;
  sampleCanvas.width = bitmap.width;
  sampleCanvas.height = bitmap.height;
  sampleCanvas.style.width = `${maxW}px`;
  sampleCanvas.style.height = `${Math.round(bitmap.height * scale)}px`;
  sampleCtx.drawImage(bitmap, 0, 0);
  sampleEpochTag.textContent = training.epoch ? ` · epoch ${training.epoch}` : '';
  sampleSteerTarget.textContent = formatSigned(target.steer);
  sampleSteerPred.textContent = formatSigned(prediction.steer);
  sampleSteerErr.textContent = formatSigned(Math.abs(target.steer - prediction.steer));
  sampleThrottleTarget.textContent = formatSigned(target.throttle);
  sampleThrottlePred.textContent = formatSigned(prediction.throttle);
  sampleThrottleErr.textContent = formatSigned(Math.abs(target.throttle - prediction.throttle));
}

function renderMetrics() {
  const batches = training.batchLosses;
  const epochs = training.epochLog;
  const lastEpoch = epochs[epochs.length - 1];
  const lastBatch = batches[batches.length - 1];
  // Until the epoch callback arrives, show the mean of the batches in the
  // current epoch. Once it arrives, use tfjs's epoch-level mean (which also
  // accounts correctly for a short final batch).
  const priorBatches = lastEpoch ? lastEpoch.atBatch : 0;
  const currentBatches = batches.slice(priorBatches);
  const avg = lastEpoch && priorBatches === batches.length
    ? lastEpoch.loss
    : currentBatches.length
      ? currentBatches.reduce((sum, value) => sum + value, 0) / currentBatches.length
      : lastEpoch?.loss;
  batchLossValue.textContent = formatLoss(lastBatch);
  avgLossValue.textContent = formatLoss(avg);
  valLossValue.textContent = formatLoss(lastEpoch?.valLoss);
  valAccuracyValue.textContent = Number.isFinite(lastEpoch?.valAccuracy)
    ? `${(lastEpoch.valAccuracy * 100).toFixed(1)}%`
    : '—';
}

// Log-scale y: the first batches' loss dwarfs everything after, and a
// linear axis would flatten the entire interesting tail into one pixel.
function drawChart() {
  const cssWidth = chart.clientWidth || 640;
  const cssHeight = chart.clientHeight || 320;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(cssWidth * dpr), h = Math.round(cssHeight * dpr);
  if (chart.width !== w || chart.height !== h) {
    chart.width = w;
    chart.height = h;
  }
  ctx.clearRect(0, 0, w, h);
  const bl = training.batchLosses;
  const el = training.epochLog;
  const left = 58 * dpr, right = 16 * dpr, top = 18 * dpr, bottom = 34 * dpr;
  const plotW = Math.max(w - left - right, 1);
  const plotH = Math.max(h - top - bottom, 1);
  const font = `${11 * dpr}px 'IBM Plex Mono', monospace`;
  ctx.font = font;
  ctx.textBaseline = 'middle';

  if (bl.length < 2) {
    drawAxes(w, h, left, top, right, bottom, font);
    return;
  }

  let lo = Infinity, hi = -Infinity;
  for (const v of bl) if (Number.isFinite(v) && v > 0) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (const e of el) { const v = e.valLoss; if (Number.isFinite(v) && v > 0) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (!Number.isFinite(lo)) return;
  const llo = Math.log10(lo);
  const span = Math.max(Math.log10(hi) - llo, 1e-3);
  const X = (i) => left + (i / Math.max(bl.length - 1, 1)) * plotW;
  const Y = (v) => top + plotH - ((Math.log10(Math.max(v, 1e-8)) - llo) / span) * plotH;

  drawAxes(w, h, left, top, right, bottom, font, llo, span);

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

function drawAxes(w, h, left, top, right, bottom, font, llo, span) {
  const dpr = window.devicePixelRatio || 1;
  const plotRight = w - right * dpr / dpr;
  const plotBottom = h - bottom;
  ctx.strokeStyle = AXIS;
  ctx.fillStyle = LABEL;
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, plotBottom);
  ctx.lineTo(plotRight, plotBottom);
  ctx.stroke();
  ctx.font = font;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  if (Number.isFinite(llo)) {
    for (let i = 0; i <= 4; i++) {
      const y = top + (h - top - bottom) * i / 4;
      const value = 10 ** (llo + span * (1 - i / 4));
      ctx.fillText(value >= 1 ? value.toFixed(1) : value.toPrecision(2), left - 8 * dpr, y);
    }
  }
  ctx.textAlign = 'center';
  ctx.fillText('batch', (left + plotRight) / 2, h - 11 * dpr);
  ctx.save();
  ctx.translate(13 * dpr, (top + plotBottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('loss (log scale)', 0, 0);
  ctx.restore();
}

new ResizeObserver(drawChart).observe(chart);
new ResizeObserver(drawSteeringChart).observe(steeringChart);

function drawSteeringChart() {
  const cssWidth = steeringChart.clientWidth || 640;
  const cssHeight = steeringChart.clientHeight || 240;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(cssWidth * dpr), h = Math.round(cssHeight * dpr);
  if (steeringChart.width !== w || steeringChart.height !== h) {
    steeringChart.width = w;
    steeringChart.height = h;
  }
  steeringCtx.clearRect(0, 0, w, h);

  const slice = training.steeringSlice;
  const targets = slice?.targets || [];
  const predictions = slice?.predictions || [];
  if (!targets.length || targets.length !== predictions.length) return;

  const left = 58 * dpr, right = 16 * dpr, top = 18 * dpr, bottom = 34 * dpr;
  const plotRight = w - right;
  const plotBottom = h - bottom;
  const plotW = Math.max(plotRight - left, 1);
  const plotH = Math.max(plotBottom - top, 1);
  const X = (i) => left + (i / Math.max(targets.length - 1, 1)) * plotW;
  const Y = (value) => top + (1 - (Math.max(-1, Math.min(1, value)) + 1) / 2) * plotH;
  const font = `${11 * dpr}px 'IBM Plex Mono', monospace`;

  steeringCtx.strokeStyle = AXIS;
  steeringCtx.fillStyle = LABEL;
  steeringCtx.lineWidth = dpr;
  steeringCtx.beginPath();
  steeringCtx.moveTo(left, top);
  steeringCtx.lineTo(left, plotBottom);
  steeringCtx.lineTo(plotRight, plotBottom);
  steeringCtx.stroke();
  steeringCtx.font = font;
  steeringCtx.textAlign = 'right';
  steeringCtx.textBaseline = 'middle';
  for (const value of [-1, 0, 1]) steeringCtx.fillText(String(value), left - 8 * dpr, Y(value));
  steeringCtx.textAlign = 'center';
  steeringCtx.fillText('training frame', (left + plotRight) / 2, h - 11 * dpr);
  steeringCtx.save();
  steeringCtx.translate(13 * dpr, (top + plotBottom) / 2);
  steeringCtx.rotate(-Math.PI / 2);
  steeringCtx.fillText('steering', 0, 0);
  steeringCtx.restore();

  drawTrace(targets, LIGHT, 1.5, 'recorded');
  drawTrace(predictions, CONE, 2, 'predicted');
  steeringCtx.textAlign = 'left';
  steeringCtx.textBaseline = 'top';
  steeringCtx.fillStyle = LIGHT;
  steeringCtx.fillText('recorded', left + 8 * dpr, top + 5 * dpr);
  steeringCtx.fillStyle = CONE;
  steeringCtx.fillText('predicted', left + 92 * dpr, top + 5 * dpr);
  steeringCtx.fillStyle = LABEL;
  steeringCtx.textAlign = 'right';
  steeringCtx.fillText(`epoch ${slice.epoch}`, plotRight, top + 5 * dpr);

  function drawTrace(values, color, width) {
    steeringCtx.strokeStyle = color;
    steeringCtx.lineWidth = width * dpr;
    steeringCtx.beginPath();
    values.forEach((value, i) => { if (i) steeringCtx.lineTo(X(i), Y(value)); else steeringCtx.moveTo(X(i), Y(value)); });
    steeringCtx.stroke();
  }
}

onTraining(render);
render();
