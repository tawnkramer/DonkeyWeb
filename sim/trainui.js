import { training, trainStart, trainStop, trainSampleAt, onTraining } from '../train/trainer.js';
import { PROFILES, DEFAULT_PROFILE } from '../train/model.js';
import { tub } from '../data/tub.js';
import { dbGet } from '../data/db.js';
import { onModeChange } from './mode.js';
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
const saliencyCanvas = document.getElementById('sampleSaliency');
const saliencyCtx = saliencyCanvas.getContext('2d');
const saliencyBtns = [...document.querySelectorAll('.salBtn')];
const sampleFrameWrap = document.getElementById('sampleFrameWrap');
const frameSlider = document.getElementById('sampleFrameSlider');
const frameTag = document.getElementById('sampleFrameTag');
const saliencyPending = document.getElementById('saliencyPending');
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
      // Whatever frame you were looking at when you pressed train is the one
      // the run explains itself with -- picking it beforehand is the point of
      // the picker working with no model loaded.
      sampleId: currentFrame()?.id ?? null,
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
  followWorkerFrame();
  drawSample();
}

function formatLoss(value) {
  return Number.isFinite(value) ? value.toFixed(4) : '—';
}

function formatSigned(value) {
  return Number.isFinite(value) ? value.toFixed(3) : '—';
}

// Which head's saliency is on show. Defaults to steering rather than off
// because an overlay nobody discovers is worth nothing, and alpha keeps the
// frame readable underneath -- 'off' is there for when you want the raw
// pixels back.
let saliencyMode = 'steer';
for (const b of saliencyBtns) {
  b.addEventListener('click', () => {
    saliencyMode = b.dataset.sal;
    for (const other of saliencyBtns) other.setAttribute('aria-pressed', String(other === b));
    drawSample();
  });
}

// The frame picker is the page's own, not the worker's: tub.frames already
// holds every recorded frame's steering and throttle in memory, and the image
// for any one of them is a single dbGet away. So scrubbing works before a
// model exists, and once one does it still never waits on the worker for the
// picture -- only for the reading the worker alone can give.
let frameIdx = 0;              // position in tub.frames
let frameBitmap = null;        // decoded picture for frameIdx, at input size
let frameDrawSeq = 0;          // abandons decodes the thumb has moved past
let frameDebounce = null;      // gates only the worker request, never the draw

function currentFrame() { return tub.frames[frameIdx] || null; }

// Whatever the model most recently said, but only if it was talking about the
// frame on screen. Anything else is a reading for a picture that is no longer
// there, and showing it against this one would be a straightforward lie.
function readingForCurrent() {
  const s = training.sample, frame = currentFrame();
  return s && frame && s.id === frame.id ? s : null;
}

async function showFrame(idx, { ask = true } = {}) {
  if (!tub.frames.length) return;
  frameIdx = Math.max(0, Math.min(tub.frames.length - 1, idx));
  const frame = currentFrame();
  drawSample(); // numbers, slider position and overlay state, before any I/O
  const seq = ++frameDrawSeq;
  const bmp = await decodeTubFrame(frame.id);
  if (seq !== frameDrawSeq) { if (bmp) bmp.close(); return; } // scrubbed past
  if (frameBitmap) frameBitmap.close();
  frameBitmap = bmp;
  drawSample();
  // The expensive half is debounced, the picture above is not: a drag across
  // 900 frames should cost 900 cheap decodes and one gradient pass, not 900
  // of each.
  if (!ask) return;
  clearTimeout(frameDebounce);
  frameDebounce = setTimeout(() => {
    frameDebounce = null;
    const f = currentFrame();
    if (f) trainSampleAt(f.id);
  }, 50);
}

// Decoded to the model's input size rather than the recorded size, because
// this panel's whole claim is that it shows what the network sees -- and the
// saliency overlay is one byte per input pixel, so anything else would fail
// to register with it.
async function decodeTubFrame(id) {
  try {
    const rec = await dbGet(id);
    if (!rec || !rec.img) return null;
    const src = await createImageBitmap(rec.img);
    const { w, h } = PROFILES[profileSelect.value] || PROFILES[DEFAULT_PROFILE];
    const out = await createImageBitmap(src, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
    src.close();
    return out;
  } catch (err) {
    console.warn('sample frame: could not decode', id, err);
    return null;
  }
}

frameSlider.addEventListener('input', () => {
  showFrame(Number(frameSlider.value));
});

// Opening frame, same rule the worker uses when the page has not chosen one:
// the sharpest turn in the recording, because a frame where the car is barely
// steering has no decision in it to explain. Re-evaluated whenever the Train
// screen is opened, since a few more laps may have been recorded since the
// last look -- but never once the user has scrubbed somewhere deliberately.
let framePicked = false;
function pickOpeningFrame() {
  if (framePicked || !tub.frames.length) return;
  framePicked = true;
  let best = 0;
  for (let i = 1; i < tub.frames.length; i++) {
    if (Math.abs(tub.frames[i].steer) > Math.abs(tub.frames[best].steer)) best = i;
  }
  showFrame(best);
}

onModeChange((mode) => {
  if (mode === 'train') pickOpeningFrame();
});

// The worker announces which frame it explained each epoch. Normally that is
// the one already on screen, but a run started before the tub had loaded --
// or one whose chosen frame was trimmed away since -- will have picked its
// own, and the picture has to follow it or the two would describe different
// frames. Never mid-drag, and only on an actual change.
let followedId = null;
function followWorkerFrame() {
  const sample = training.sample;
  if (!sample || frameDebounce !== null || sample.id === followedId) return;
  followedId = sample.id;
  if (currentFrame()?.id === sample.id) return;
  const idx = tub.frames.findIndex((f) => f.id === sample.id);
  if (idx >= 0) showFrame(idx, { ask: false });
}

// Enlarging is a class on the panel, not a redraw: both canvases keep their
// drawing buffers at the model's input resolution and CSS scales them, so
// zooming costs nothing and stays sharp-edged (image-rendering:pixelated) --
// you are meant to see the actual input pixels, not a smoothed guess at
// what is between them.
sampleFrameWrap.addEventListener('click', () => {
  const zoomed = sampleWrap.classList.toggle('zoomed');
  sampleFrameWrap.setAttribute('aria-expanded', String(zoomed));
});

// Heat ramp: transparent at zero, cone orange through the middle, white at
// the peak. Alpha carries most of the signal deliberately -- the point of
// the overlay is seeing WHICH part of the image the gradient sits on, which
// fails if a solid colour hides the road underneath it.
function heatInto(out, p, t) {
  const hot = Math.max(0, t - 0.65) / 0.35; // whitening ramp for the top third
  out[p] = 255;
  out[p + 1] = Math.round(106 + 149 * hot);
  out[p + 2] = Math.round(43 + 212 * hot);
  out[p + 3] = Math.round(230 * t);
}

function drawSaliency(reading) {
  const map = saliencyMode !== 'off' && reading && reading.saliency && reading.saliency[saliencyMode];
  saliencyCanvas.hidden = !map;
  // Only while a map is genuinely on its way: a frame whose prediction has
  // landed but whose gradients are still running. 'off' is a choice rather
  // than a wait, and with no model at all there is nothing to wait for --
  // saying "computing" in either case would be a promise that never resolves.
  saliencyPending.hidden = !(saliencyMode !== 'off' && reading && !reading.saliency);
  if (!map) return;
  // Sized from the map's own grid, not the picture's. They are normally the
  // same -- both the model's input size -- but the page decodes at whatever
  // the profile dropdown currently says while the maps come from whatever the
  // model was actually trained at, and those can differ. CSS stretches the
  // overlay across the frame either way (see #sampleSaliency), so taking the
  // map's dimensions here keeps the heat spread over the whole picture
  // instead of packed into a corner of it.
  const w = reading.w || (frameBitmap && frameBitmap.width);
  const h = reading.h || (frameBitmap && frameBitmap.height);
  if (!w || !h || map.length !== w * h) return;
  if (saliencyCanvas.width !== w || saliencyCanvas.height !== h) {
    saliencyCanvas.width = w;
    saliencyCanvas.height = h;
  }
  const img = saliencyCtx.createImageData(w, h);
  for (let i = 0, p = 0; i < map.length; i++, p += 4) heatInto(img.data, p, map[i] / 255);
  saliencyCtx.putImageData(img, 0, 0);
}

// A recorded frame as actual pixels -- what the model's forward pass receives
// -- next to what you did and, once there is a model, what it says. "The
// network is wrong here" gets a picture to point at instead of just a gap
// between two lines, and the saliency overlay goes a step further: not only
// that it is wrong, but what it was looking at when it got it wrong.
//
// Everything here except the prediction columns works with no model at all,
// which is what lets you line up an interesting frame before committing to a
// run rather than discovering afterwards that it explained a straight.
function drawSample() {
  const frame = currentFrame();
  sampleWrap.hidden = !frame;
  if (!frame) return;
  syncSlider();
  if (frameBitmap) {
    // Display size is CSS's job (see #sampleFrameWrap) -- this is the drawing
    // buffer, which must stay at the model's true input resolution for the
    // overlay to line up with it pixel for pixel.
    if (sampleCanvas.width !== frameBitmap.width || sampleCanvas.height !== frameBitmap.height) {
      sampleCanvas.width = frameBitmap.width;
      sampleCanvas.height = frameBitmap.height;
    }
    sampleCtx.drawImage(frameBitmap, 0, 0);
  }
  const reading = readingForCurrent();
  drawSaliency(reading);
  sampleEpochTag.textContent = training.epoch ? ` · epoch ${training.epoch}` : '';
  const pred = reading && reading.prediction;
  sampleSteerTarget.textContent = formatSigned(frame.steer);
  sampleSteerPred.textContent = pred ? formatSigned(pred.steer) : '—';
  sampleSteerErr.textContent = pred ? formatSigned(Math.abs(frame.steer - pred.steer)) : '—';
  sampleThrottleTarget.textContent = formatSigned(frame.throttle);
  sampleThrottlePred.textContent = pred ? formatSigned(pred.throttle) : '—';
  sampleThrottleErr.textContent = pred ? formatSigned(Math.abs(frame.throttle - pred.throttle)) : '—';
}

// The slider is the page's, so this only reflects state it already owns.
// Skipped mid-drag, where writing .value back would fight the thumb under
// the user's finger.
function syncSlider() {
  const count = tub.frames.length;
  frameSlider.disabled = count < 2;
  frameSlider.max = String(Math.max(0, count - 1));
  if (frameDebounce === null) frameSlider.value = String(frameIdx);
  frameTag.textContent = count ? `${frameIdx + 1} / ${count}` : '—';
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
