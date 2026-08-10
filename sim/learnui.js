import * as bp from '../train/backprop.js';
import { onSampleFrame } from './trainui.js';
import { onModeChange, getMode } from './mode.js';
import { onTraining } from '../train/trainer.js';
import { listModels, getActiveModelId } from '../train/models.js';

// ---------- backprop panel ----------
// The five acts of one training step: forward, compare, backward, step,
// forward again. Everything tensor-shaped is in train/backprop.js; this file
// only moves DOM around, the same split trainui.js has against trainer.js.
//
// The order matters more than it looks. Red does not appear until the output
// meets the label, because before that point there is no error to draw --
// only activations. The learning rate is applied once, to the weight update,
// and nowhere else. And the payoff is act 5 rather than act 3: what shrinks
// is the loss on the NEXT pass, not the gradient on its way back. Getting
// any of those wrong would teach a mechanism this app does not implement.

const panel = document.getElementById('backpropPanel');
const stage = document.getElementById('bpLayers');
const caption = document.getElementById('bpCaption');
const actName = document.getElementById('bpActName');
const lossValue = document.getElementById('bpLoss');
const stepsValue = document.getElementById('bpSteps');
const lrValue = document.getElementById('bpLrValue');
const weightLine = document.getElementById('bpWeight');
const nextBtn = document.getElementById('bpNextBtn');
const autoBtn = document.getElementById('bpAutoBtn');
const resetBtn = document.getElementById('bpResetBtn');
const lrSlider = document.getElementById('bpLr');
const sourceSelect = document.getElementById('bpSource');
const logScale = document.getElementById('bpLogScale');
const modelTag = document.getElementById('bpModelTag');

// Log-spaced, because the interesting range is multiplicative: the distance
// from 0.001 to 0.01 is the same lesson as 0.01 to 0.1, and a linear slider
// would spend most of its travel between 0.25 and 0.5 where everything
// simply diverges.
const LR_MIN = 1e-4;
const LR_MAX = 0.5;
const DEFAULT_LR = 0.01;
const sliderToLr = (v) => LR_MIN * (LR_MAX / LR_MIN) ** (v / 100);
const lrToSlider = (rate) => 100 * (Math.log(rate / LR_MIN) / Math.log(LR_MAX / LR_MIN));
// A whole-number slider position cannot land on 0.01 (it falls at 54.07), and
// a default rate that reads "0.0099" looks like a rounding bug in a panel
// whose whole subject is what that number does.
lrSlider.step = '0.01';
lrSlider.value = String(lrToSlider(DEFAULT_LR));

const ACTS = ['idle', 'forward', 'error', 'backward', 'step', 'again'];
const BUTTON_TEXT = {
  idle: 'run forward pass',
  forward: 'show the error',
  error: 'propagate backward',
  backward: 'apply the step',
  step: 'run forward again',
  again: 'propagate backward',
};
const ACT_LABEL = {
  idle: 'ready', forward: '1 · forward', error: '2 · compare',
  backward: '3 · backward', step: '4 · update', again: '5 · forward again',
};

const reduceMotion = matchMedia('(prefers-reduced-motion:reduce)');
const STAGGER_MS = 90;

let sandbox = null;
let building = null;      // in-flight createSandbox, so two clicks make one model
let latest = null;        // newest {frame, bitmap, profile} from trainui
let act = 'idle';
let busy = false;
let auto = null;          // interval id while the Auto toggle is on
let reveal = [];          // pending stagger timers, cancelled on any new act
let cols = [];            // per-layer column elements, by layer name
let errorCol = null;
let frameCanvas = null;
let errorScale = 0;       // held ACROSS acts: act 5's bars must be directly
                          // comparable with act 2's or the shrink is invisible
let lastForward = null;
let lastBackward = null;

function lr() { return sliderToLr(Number(lrSlider.value)); }
function fmt(v, digits = 3) { return Number.isFinite(v) ? v.toFixed(digits) : '—'; }
function fmtSmall(v) { return Number.isFinite(v) ? v.toExponential(1) : '—'; }
// Fixed-point until the value stops being readable that way. A diverging run
// produces activations in the billions, and "9792068608.000" under a 76px
// column is a wall of digits where a magnitude was wanted.
function fmtMag(v, digits = 3) {
  if (!Number.isFinite(v)) return '—';
  const size = Math.abs(v);
  return size !== 0 && (size >= 1000 || size < 1e-3) ? v.toExponential(2) : v.toFixed(digits);
}

// ---------- building the diagram ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildColumn({ name, shape, tracks, input }) {
  const col = el('div', 'bpCol');
  col.append(el('div', 'bpName', name), el('div', 'bpShape', shape));
  const trackWrap = el('div', 'bpTracks');
  const fills = [];
  if (input) {
    frameCanvas = document.createElement('canvas');
    frameCanvas.id = 'bpFrame';
    trackWrap.append(frameCanvas);
    col.classList.add('bpColInput');
  } else {
    for (const kind of tracks) {
      const track = el('div', `bpTrack bpTrack${kind}`);
      const fill = el('i', 'bpFill');
      track.append(fill);
      let step = null;
      if (kind === 'Grad') {
        step = el('i', 'bpStep');
        track.append(step);
      }
      fills.push({ fill, step });
      trackWrap.append(track);
    }
  }
  col.append(trackWrap);
  const nums = el('div', 'bpNums');
  col.append(nums);
  return { col, fills, nums };
}

function buildDiagram(state) {
  stage.replaceChildren();
  cols = new Map();
  frameCanvas = null;

  const inputCol = buildColumn({
    name: 'frame', shape: `${state.inputW}×${state.inputH}×3`, input: true,
  });
  inputCol.col.classList.add('lit');
  stage.append(inputCol.col);
  drawFrameThumb();

  for (const column of state.columns) {
    const built = buildColumn({
      name: column.name,
      shape: column.shape,
      tracks: column.params ? ['Act', 'Grad'] : ['Act'],
    });
    built.column = column;
    cols.set(column.name, built);
    stage.append(built.col);
  }

  errorCol = buildColumn({ name: 'error', shape: 'predicted − recorded', tracks: ['Err', 'Err'] });
  errorCol.col.classList.add('bpColError');
  stage.append(errorCol.col);
}

function drawFrameThumb() {
  if (!frameCanvas || !latest || !latest.bitmap) return;
  try {
    frameCanvas.width = latest.bitmap.width;
    frameCanvas.height = latest.bitmap.height;
    frameCanvas.getContext('2d').drawImage(latest.bitmap, 0, 0);
  } catch { /* superseded bitmap; the next frame event redraws it */ }
}

// ---------- painting ----------

function clearReveal() {
  for (const t of reveal) clearTimeout(t);
  reveal = [];
}

// Lights the columns one at a time in the direction the pass travels. The
// order IS the lesson -- a forward pass that appeared all at once would not
// show that each layer only sees what the one before it produced.
function revealInOrder(names, backwards, paint) {
  clearReveal();
  stage.classList.toggle('back', !!backwards);
  const order = backwards ? [...names].reverse() : names;
  if (reduceMotion.matches) {
    order.forEach((n) => { lit(n); paint(n); });
    return;
  }
  order.forEach((name, i) => {
    reveal.push(setTimeout(() => { lit(name); paint(name); }, i * STAGGER_MS));
  });
}

function lit(name) {
  const entry = name === '__error' ? errorCol : cols.get(name);
  if (entry) entry.col.classList.add('lit');
}

function dimAll() {
  for (const entry of cols.values()) entry.col.classList.remove('lit');
  if (errorCol) errorCol.col.classList.remove('lit');
}

// minPercent keeps a non-zero quantity from rendering as nothing. The step
// sliver needs it: at a rate of 0.01 the step really is 1% of the gradient,
// which is the honest picture and also less than a pixel, so the one thing
// act 4 exists to show would be invisible at the default setting.
function setBar(fill, fraction, minPercent = 0) {
  // A diverged model produces NaN, and "NaN%" is a value CSS silently drops --
  // leaving the previous height in place, which would show a stale bar as if
  // it were current. Collapse to zero instead.
  const percent = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) * 100 : 0;
  fill.style.height = `${percent > 0 ? Math.max(percent, minPercent) : 0}%`;
}

const STEP_MIN_PERCENT = 1.6;

function clearGradientBars() {
  for (const entry of cols.values()) {
    if (entry.fills.length < 2) continue;
    setBar(entry.fills[1].fill, 0);
    setBar(entry.fills[1].step, 0);
  }
}

// Bars are normalised within a pass against the largest of them, so height
// compares layers to each other. Log mode exists because the spread across a
// deep net is multiplicative: on a linear scale the early conv columns are a
// bar too short to see -- which is the vanishing-gradient lesson, so it is
// the default, with this to reveal the structure underneath it.
function scaler(values) {
  const max = Math.max(...values, 0);
  if (!(max > 0)) return () => 0;
  if (!logScale.checked) return (v) => v / max;
  const floor = Math.max(max * 1e-6, Number.MIN_VALUE);
  const span = Math.log10(max) - Math.log10(floor);
  return (v) => (v > 0 ? Math.max(0, (Math.log10(Math.max(v, floor)) - Math.log10(floor)) / span) : 0);
}

function paintActivations(activations) {
  const scale = scaler(activations.map((a) => a.rms));
  const byName = new Map(activations.map((a) => [a.name, a]));
  const names = activations.map((a) => a.name);
  revealInOrder(names, false, (name) => {
    const entry = cols.get(name);
    const a = byName.get(name);
    if (!entry || !a) return;
    setBar(entry.fills[0].fill, scale(a.rms));
    const live = a.live == null ? '' : ` · ${Math.round(a.live * 100)}% live`;
    entry.nums.replaceChildren(numLine('b', `${fmtMag(a.rms)}${live}`));
  });
}

function numLine(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

// `withStep` is false for act 3 and true for act 4: the sliver is the only
// thing act 4 adds, so drawing it a beat early would leave that act with
// nothing to show. Dragging the rate during act 3 reveals it early on
// purpose -- a preview of what the step is about to do is worth finding.
function paintGradients(layerGrads, withStep = false) {
  const scale = scaler(layerGrads.map((g) => g.rms));
  const rate = lr();
  const byName = new Map(layerGrads.map((g) => [g.name, g]));
  // Walk every column, not just the ones with weights: flatten has nothing to
  // blame and so gets no bar, but skipping it would break the chain the
  // reveal is drawing.
  const names = [...cols.keys()];
  revealInOrder(names, true, (name) => {
    const entry = cols.get(name);
    const g = byName.get(name);
    if (!entry || !g || entry.fills.length < 2) return;
    const height = scale(g.rms);
    setBar(entry.fills[1].fill, height);
    // The step is the same bar scaled by the rate -- drawn inside it so the
    // two are impossible to read as independent quantities.
    setBar(entry.fills[1].step, withStep ? height * rate : 0, STEP_MIN_PERCENT);
    entry.nums.replaceChildren(
      numLine('b', fmtMag(byNameAct(name))),
      numLine('em', fmtSmall(g.rms)),
    );
  });
}

function byNameAct(name) {
  const a = lastForward && lastForward.activations.find((x) => x.name === name);
  return a ? a.rms : NaN;
}

function paintStep() {
  const rate = lr();
  for (const entry of cols.values()) {
    if (entry.fills.length < 2) continue;
    const gradHeight = parseFloat(entry.fills[1].fill.style.height) || 0;
    setBar(entry.fills[1].step, (gradHeight / 100) * rate, STEP_MIN_PERCENT);
  }
}

function paintError(error) {
  const magnitude = Math.max(Math.abs(error.steer), Math.abs(error.throttle));
  // Fixed on first sight and kept: act 5 re-uses act 2's scale, because a bar
  // that renormalised every pass could never show the error getting smaller.
  if (!errorScale) errorScale = Math.max(magnitude, 0.05);
  const scale = (v) => v / errorScale;
  setBar(errorCol.fills[0].fill, scale(Math.abs(error.steer)));
  setBar(errorCol.fills[1].fill, scale(Math.abs(error.throttle)));
  errorCol.nums.replaceChildren(
    numLine('em', `steer ${fmt(error.steer)}`),
    numLine('em', `thr ${fmt(error.throttle)}`),
  );
  lit('__error');
}

// ---------- the acts ----------

const CAPTIONS = {
  idle: 'Press <b>run forward pass</b> to send the frame above through the network.',
  forward: 'The frame goes through layer by layer. These pale bars are <b>activations</b> — how strongly each layer responds. Nothing is wrong yet, because nothing has been compared to anything.',
  error: 'Now the two predictions meet what you actually recorded. The gap is the <em>error</em>, and this is the first moment it exists.',
  backward: 'That error is traced back through every layer as blame — the <em>gradient</em> of the loss with respect to each layer\'s weights. It does not shrink neatly on the way back; watch how much smaller the early layers are than the heads.',
  step: 'Each weight moves against its gradient, scaled by the learning rate: <b>Δw = −rate × gradient</b>. The white sliver inside each bar is that step. Change the rate and it resizes; the gradient behind it does not.',
  again: 'The same frame, through the updated network. The error bars are shorter. <b>That</b> is what learning looks like — not the gradient shrinking on the way back, but the model being less wrong the next time it is asked.',
};

function setCaption(name) {
  caption.innerHTML = CAPTIONS[name];
  actName.textContent = ACT_LABEL[name];
}

async function advance() {
  if (busy || !sandbox || !bp.hasFrame(sandbox)) return;
  busy = true;
  nextBtn.disabled = true;
  try {
    const next = ACTS[(ACTS.indexOf(act) + 1) % ACTS.length];
    // After act 5 the network has just been run forward, so the loop rejoins
    // at the backward pass rather than repeating a pass we already have.
    const target = act === 'again' ? 'backward' : next;
    await runAct(target);
    act = target;
  } catch (err) {
    caption.textContent = String(err.message || err);
    stopAuto();
  } finally {
    busy = false;
    syncControls();
  }
}

async function runAct(name) {
  // Cancel the previous act's stagger BEFORE doing anything else. The forward
  // acts clear the gradient bars and then await a real GPU pass, and any
  // timers still pending from act 4's reveal would fire during that await and
  // paint the bars straight back in -- stale, and attached to weights that no
  // longer exist. Clicking through quickly is enough to trigger it.
  clearReveal();
  switch (name) {
    case 'forward':
    case 'again': {
      dimAll();
      // The gradient bars still on screen were computed against the weights
      // as they were BEFORE the step. Leaving them up next to fresh
      // activations would put a stale number and a current one in the same
      // column with nothing to tell them apart.
      clearGradientBars();
      lastBackward = null;
      lastForward = await bp.forward(sandbox);
      paintActivations(lastForward.activations);
      lossValue.textContent = fmtMag(lastForward.loss, 4);
      if (name === 'again') paintError(lastForward.error);
      break;
    }
    case 'error': {
      paintError(lastForward.error);
      break;
    }
    case 'backward': {
      lastBackward = await bp.backward(sandbox);
      lossValue.textContent = fmtMag(lastBackward.loss, 4);
      paintGradients(lastBackward.layerGrads);
      break;
    }
    case 'step': {
      const result = await bp.applyStep(sandbox, lr());
      stepsValue.textContent = String(result.steps);
      showWeight(result.sample);
      // Same gradient bars, now with the slice of each that was actually
      // applied drawn inside them.
      if (lastBackward) paintGradients(lastBackward.layerGrads, true);
      break;
    }
    default: break;
  }
  setCaption(name);

  // A rate near the top of the slider can send the weights to infinity in two
  // or three steps, and from there every number on the panel is NaN forever.
  // That is a real and instructive outcome, so it is named rather than
  // hidden -- but it needs to say how to get out, because nothing except
  // reset will.
  if (lastForward && !Number.isFinite(lastForward.loss)) {
    stopAuto();
    caption.innerHTML = 'The weights have run off to <em>infinity</em>. '
      + 'That step was too big to recover from — the model is gone, and every '
      + 'number here will stay blank until you press <b>reset</b>. '
      + 'Lower the rate before stepping again.';
  }
}

// One real weight, named and numbered, so "the model changed" is something
// you can check rather than something the panel asserts.
function showWeight(sample) {
  if (!sample || !Number.isFinite(sample.after)) { weightLine.textContent = ''; return; }
  weightLine.replaceChildren(
    numLine('span', `${sample.layer}: one weight `),
    numLine('em', sample.before.toFixed(5)),
    numLine('span', ' − '),
    numLine('em', `${sample.lr.toFixed(4)} × ${sample.grad.toExponential(3)}`),
    numLine('span', ' → '),
    numLine('em', sample.after.toFixed(5)),
  );
}

// ---------- sandbox lifecycle ----------

async function ensureSandbox() {
  if (sandbox || building) return building;
  building = (async () => {
    const source = sourceSelect.value || 'fresh';
    const next = await bp.createSandbox({ source });
    sandbox = next;
    buildDiagram(sandbox);
    modelTag.textContent = `· ${sandbox.inputW}×${sandbox.inputH} input, ${sandbox.columns.reduce((n, c) => n + c.params, 0).toLocaleString()} weights`;
    applyLatestFrame();
    resetActs();
  })().finally(() => { building = null; });
  return building;
}

async function rebuild() {
  stopAuto();
  if (sandbox) { bp.dispose(sandbox); sandbox = null; }
  await ensureSandbox();
}

function applyLatestFrame() {
  if (!sandbox || !latest || !latest.bitmap || !latest.frame) return;
  try {
    bp.setFrame(sandbox, latest.bitmap, {
      steer: latest.frame.steer,
      throttle: latest.frame.throttle,
    });
  } catch { /* the bitmap was superseded mid-scrub; the next event re-sets it */ }
}

function resetActs() {
  clearReveal();
  act = 'idle';
  lastForward = null;
  lastBackward = null;
  errorScale = 0;
  weightLine.textContent = '';
  lossValue.textContent = '—';
  dimAll();
  if (cols.size) for (const entry of cols.values()) {
    for (const { fill, step } of entry.fills) { setBar(fill, 0); if (step) setBar(step, 0); }
    entry.nums.replaceChildren();
  }
  if (errorCol) for (const { fill } of errorCol.fills) setBar(fill, 0);
  const first = stage.firstElementChild;
  if (first) first.classList.add('lit');
  setCaption('idle');
  syncControls();
}

// ---------- controls ----------

function syncControls() {
  const ready = !!sandbox && bp.hasFrame(sandbox);
  nextBtn.disabled = busy || !ready;
  nextBtn.textContent = BUTTON_TEXT[act];
  resetBtn.disabled = !sandbox;
  lrValue.textContent = lr().toFixed(4);
  stepsValue.textContent = sandbox ? String(sandbox.steps) : '0';
}

nextBtn.addEventListener('click', () => { advance(); });

resetBtn.addEventListener('click', () => {
  stopAuto();
  if (!sandbox) return;
  bp.reset(sandbox);
  resetActs();
});

lrSlider.addEventListener('input', () => {
  lrValue.textContent = lr().toFixed(4);
  // Redrawing the step sliver live is the point of the control: the gradient
  // bar stays put while the slice actually applied to it resizes.
  if (act === 'backward' || act === 'step') paintStep();
});

logScale.addEventListener('change', () => {
  if (lastBackward && (act === 'backward' || act === 'step')) paintGradients(lastBackward.layerGrads, act === 'step');
  else if (lastForward) paintActivations(lastForward.activations);
});

sourceSelect.addEventListener('change', () => { rebuild(); });

function stopAuto() {
  if (auto) clearInterval(auto);
  auto = null;
  autoBtn.setAttribute('aria-pressed', 'false');
}

autoBtn.addEventListener('click', () => {
  if (auto) { stopAuto(); return; }
  autoBtn.setAttribute('aria-pressed', 'true');
  auto = setInterval(() => {
    if (!busy) advance();
  }, reduceMotion.matches ? 400 : 900);
});

async function refreshSources() {
  const models = await listModels().catch(() => []);
  const previous = sourceSelect.value;
  const options = [
    new Option('fresh untrained model', 'fresh'),
    ...models.map((m) => new Option(`copy · ${m.name}`, m.id)),
  ];
  const active = getActiveModelId();
  const wanted = previous || (models.some((m) => m.id === active) ? active : 'fresh');
  for (const option of options) option.selected = option.value === wanted;
  sourceSelect.replaceChildren(...options);
}

// ---------- wiring ----------

onSampleFrame((event) => {
  latest = event;
  panel.hidden = false;
  drawFrameThumb();
  // The frame arrives after the mode change that asked for it -- trainui's
  // decode is async -- so this is where the sandbox actually gets built on a
  // cold open, not in the onModeChange below.
  if (!sandbox) { if (getMode() === 'train') ensureSandbox(); return; }
  applyLatestFrame();
  // A different frame is a different question: the acts start over rather
  // than leaving act 3's bars sitting under act 1's picture.
  resetActs();
});

onTraining((t) => { if (t.state === 'done') refreshSources(); });

onModeChange((mode) => {
  if (mode !== 'train') { stopAuto(); return; }
  if (latest) ensureSandbox();
});

refreshSources().then(() => {
  if (getMode() === 'train' && latest) ensureSandbox();
});

syncControls();

export const learn = {
  get sandbox() { return sandbox; },
  get act() { return act; },
  get busy() { return busy; },
  get steps() { return sandbox ? sandbox.steps : 0; },
  get loss() { return lastForward ? lastForward.loss : null; },
  get ready() { return !!sandbox && bp.hasFrame(sandbox); },
  advance,
  ensureSandbox,
  setLr(value) { lrSlider.value = String(lrToSlider(value)); syncControls(); },
  reset() { if (sandbox) { bp.reset(sandbox); resetActs(); } },
};
