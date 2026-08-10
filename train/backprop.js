import { buildModel, PROFILES, DEFAULT_PROFILE } from './model.js';
import { getModel, modelLoadUrl } from './models.js';

// ---------- one hand-stepped training step, opened up ----------
//
// The Train page shows what training PRODUCED -- a loss curve, a steering
// fit, a saliency map -- but never how a model gets there. This module is
// the missing middle: one frame, one forward pass, one backward pass, one
// weight update, and the same frame run again so the error visibly shrinks.
// sim/learnui.js draws it; everything tensor-shaped lives here, so that file
// never touches tfjs and this one never touches the DOM (same split as
// train/trainer.js vs sim/trainui.js).
//
// It runs on the MAIN THREAD rather than in the training worker. The worker
// owns a model in the middle of fitDataset and already has to defer gradient
// work to epoch boundaries (see the comment on its `sample` handler); a
// hand-stepped sandbox has no reason to queue behind that. Importing
// ../vendor/tf.mjs here returns the same module instance train/autopilot.js
// already loaded, so this shares one tfjs and one WebGL context instead of
// opening a second.
//
// SGD is plain and hand-written on purpose. The real trainer uses Adam,
// whose step is momentum and per-weight variance scaling on top of the
// gradient -- correct, but it makes "the learning rate scales the update"
// only half-true, and that sentence is the whole point of the panel. Here
// the code is literally the sentence the UI draws: w <- w - lr * grad.

let tf = null;
async function ensureTf() {
  if (!tf) {
    tf = await import('../vendor/tf.mjs');
    await tf.ready();
  }
  return tf;
}

// Layers worth a column. Dropout is skipped because every pass here runs
// with training:false, so those layers are identity and a column for them
// would imply the network does something at that point that it doesn't.
// InputLayer is skipped too -- the frame itself is that column.
function isDrawn(layer) {
  const kind = layer.getClassName();
  return kind !== 'InputLayer' && kind !== 'Dropout';
}

function shapeLabel(shape) {
  return shape.slice(1).join('×');
}

function countParams(layer) {
  return layer.trainableWeights.reduce((n, w) => n + w.shape.reduce((a, b) => a * b, 1), 0);
}

// "How many units are awake" only means something behind a relu, where zero
// is a floor and a dead unit stays dead. The two output heads are linear, so
// on those the same number is just the sign of one prediction dressed up as
// a statistic -- the panel must not show it there.
function hasRelu(layer) {
  return layer.activation ? layer.activation.getClassName() === 'relu' : false;
}

// Build a sandbox to step on.
//
// `source` is either 'fresh' (a randomly initialised model of `profile`) or a
// model id to copy. It is a copy in both cases: stepping the same frame a
// hundred times at lr 0.5 is a thing a curious person should be able to do
// without damaging a model that took real time to train, and reset() has to
// land on the exact same starting point every time for the demo to replay.
export async function createSandbox({ profile = DEFAULT_PROFILE, source = 'fresh' } = {}) {
  await ensureTf();
  let model;
  if (source === 'fresh') {
    model = buildModel(tf, PROFILES[profile] ? profile : DEFAULT_PROFILE);
  } else {
    const record = await getModel(source);
    if (!record) throw new Error('that model is no longer available');
    model = await tf.loadLayersModel(modelLoadUrl(record));
  }

  // Read the input size off the model rather than off `profile`: a copied
  // model is self-describing and may not be the profile the picker is on.
  const [, h, w] = model.inputs[0].shape;

  const drawn = model.layers.filter(isDrawn);

  // Variable names are uniquified GLOBALLY by tfjs, so a second copy of the
  // same architecture in this tab gets 'conv2d_1/kernel_1', not
  // 'conv2d_1/kernel'. Nothing here may hardcode a name -- the map is built
  // from this model's own layers, every time.
  const vars = [];
  const varsByLayer = new Map();
  for (const layer of drawn) {
    const own = layer.trainableWeights.map((lv) => lv.val);
    if (own.length) varsByLayer.set(layer.name, own);
    vars.push(...own);
  }

  // Activations come off a sub-model over the same layer objects, built once
  // here rather than per pass. It shares weights with `model` and owns
  // nothing itself, so it is never disposed separately -- disposing it would
  // take the sandbox's weights with it.
  //
  // The two output heads are drawn layers too, so this sub-model's last
  // outputs ARE the predictions: one pass gets both the bars and the numbers
  // rather than running the network twice per act.
  const actModel = tf.model({ inputs: model.inputs, outputs: drawn.map((l) => l.output) });
  const headIdx = model.outputLayers.map((l) => drawn.findIndex((d) => d.name === l.name));

  const state = {
    tf,
    model,
    actModel,
    drawn,
    headIdx,
    source,
    inputW: w,
    inputH: h,
    vars,
    varsByLayer,
    // Weights as they were at creation, so reset() is exact rather than
    // "rebuild and hope" -- tfjs initialisers are not seeded, so a rebuilt
    // model would start somewhere else and the demo would not replay.
    snapshot: model.getWeights().map((t) => t.clone()),
    columns: drawn.map((layer) => ({
      name: layer.name,
      kind: layer.getClassName(),
      shape: shapeLabel(layer.outputShape),
      params: countParams(layer),
      relu: hasRelu(layer),
      head: model.outputLayers.some((l) => l.name === layer.name),
    })),
    x: null,          // current frame as a [1,h,w,3] tensor in [0,1]
    target: null,     // { steer, throttle } recorded labels
    pending: null,    // gradients from backward(), consumed by applyStep()
    steps: 0,
  };
  return state;
}

// The frame to learn from. Takes the ImageBitmap sim/trainui.js already
// decoded at model-input size, so there is no second dbGet and no second
// decode, and the picture the panel steps on is provably the one on screen.
export function setFrame(state, bitmap, { steer, throttle }) {
  const { tf } = state;
  if (state.x) state.x.dispose();
  state.x = tf.tidy(() => {
    let x = tf.browser.fromPixels(bitmap, 3).toFloat().div(255).expandDims(0);
    if (bitmap.height !== state.inputH || bitmap.width !== state.inputW) {
      x = tf.image.resizeBilinear(x, [state.inputH, state.inputW]);
    }
    return x;
  });
  state.target = { steer, throttle };
  clearPending(state);
}

export function hasFrame(state) {
  return !!(state && state.x && state.target);
}

// ---------- act 1 & 5: forward ----------
//
// training:false is load-bearing twice over. Dropout at 0.2 would randomise
// the activation bars between passes, and -- worse -- it would make act 5's
// shrink unattributable: the error would move for two reasons at once and
// the panel would be claiming credit for the weight update either way.
export async function forward(state) {
  const { tf, drawn, headIdx } = state;

  const packed = tf.tidy(() => {
    const values = state.actModel.apply(state.x, { training: false });
    const list = Array.isArray(values) ? values : [values];
    // One readback for everything, not one per layer: each of those is a GPU
    // stall and there are a couple of dozen per act.
    const rms = list.map((a) => tf.sqrt(tf.mean(tf.square(a))));
    const live = list.map((a) => tf.mean(tf.cast(tf.greater(a, 0), 'float32')));
    const heads = headIdx.map((i) => tf.reshape(list[i], [1]));
    return tf.concat([tf.stack(rms), tf.stack(live), ...heads]);
  });

  const all = await packed.data();
  packed.dispose();

  const n = drawn.length;
  const activations = drawn.map((layer, i) => ({
    name: layer.name,
    rms: all[i],
    // Fraction of units above zero, and null where that is not a real
    // question. A relu stack that has gone mostly dead is a genuine failure
    // mode and invisible in an RMS bar alone.
    live: hasRelu(layer) ? all[n + i] : null,
  }));
  const pred = { steer: all[2 * n], throttle: all[2 * n + 1] };
  const error = {
    steer: pred.steer - state.target.steer,
    throttle: pred.throttle - state.target.throttle,
  };
  const loss = error.steer * error.steer + error.throttle * error.throttle;
  return { activations, pred, error, loss, target: { ...state.target } };
}

// ---------- act 3: backward ----------
//
// The bar this returns is the gradient of the loss with respect to that
// layer's WEIGHTS -- what the update actually uses. It is not the activation
// delta propagating backward. The two are related but not the same thing,
// and the panel says so rather than blurring them.
export async function backward(state) {
  const { tf, model } = state;
  clearPending(state);

  const lossFn = () => tf.tidy(() => {
    const outs = model.apply(state.x, { training: false });
    const heads = Array.isArray(outs) ? outs : [outs];
    const s = tf.squaredDifference(tf.scalar(state.target.steer), tf.reshape(heads[0], []));
    const t = tf.squaredDifference(tf.scalar(state.target.throttle), tf.reshape(heads[1], []));
    // Sum, not mean, to match how the compiled model totals its two output
    // losses -- so this number is comparable with the loss graph above.
    return tf.add(s, t);
  });

  // The varList is explicit and non-negotiable. Called without one,
  // variableGrads walks tfjs's GLOBAL variable registry, which in this tab
  // also holds the autopilot's model -- it would differentiate through
  // whatever else happens to be loaded.
  const { value, grads } = tf.variableGrads(lossFn, state.vars);
  const loss = (await value.data())[0];
  value.dispose();

  const names = [...state.varsByLayer.keys()];
  const packed = tf.tidy(() => tf.stack(names.map((name) => {
    const gs = state.varsByLayer.get(name).map((v) => grads[v.name]).filter(Boolean);
    if (!gs.length) return tf.scalar(0);
    const sumSq = gs.map((g) => tf.sum(tf.square(g))).reduce((a, b) => tf.add(a, b));
    const count = gs.reduce((n, g) => n + g.size, 0);
    return tf.sqrt(tf.div(sumSq, tf.scalar(count)));
  })));
  const rmsValues = await packed.data();
  packed.dispose();

  const layerGrads = names.map((name, i) => ({ name, rms: rmsValues[i] }));
  state.pending = { grads, loss };
  return { loss, layerGrads, sample: await sampleWeight(state, grads) };
}

// One concrete weight, so "the model changed" is a number on screen and not
// a metaphor. The largest-gradient weight in the last drawn layer that has
// any: it is the one act 4 is about to move furthest.
async function sampleWeight(state, grads) {
  const { tf } = state;
  const names = [...state.varsByLayer.keys()];
  for (let i = names.length - 1; i >= 0; i--) {
    const layerName = names[i];
    for (const v of state.varsByLayer.get(layerName)) {
      const g = grads[v.name];
      if (!g || g.size === 0) continue;
      const packed = tf.tidy(() => {
        const flat = tf.reshape(g, [-1]);
        const idx = tf.argMax(tf.abs(flat));
        return tf.stack([
          tf.cast(idx, 'float32'),
          tf.reshape(tf.gather(flat, idx), []),
          tf.reshape(tf.gather(tf.reshape(v, [-1]), idx), []),
        ]);
      });
      const [index, grad, before] = await packed.data();
      packed.dispose();
      return { layer: layerName, variable: v.name, index, grad, before };
    }
  }
  return null;
}

// ---------- act 4: the step ----------
//
// Hand-written rather than tf.train.sgd().applyGradients() so this reads as
// the same sentence the panel draws. The learning rate appears exactly once,
// here, on the weight update -- never on the error as it propagates back.
export async function applyStep(state, lr) {
  if (!state.pending) throw new Error('nothing to apply -- run backward() first');
  const { tf } = state;
  const { grads } = state.pending;
  const sample = await sampleWeight(state, grads);

  tf.tidy(() => {
    for (const v of state.vars) {
      const g = grads[v.name];
      if (g) v.assign(tf.sub(v, tf.mul(g, lr)));
    }
  });

  state.steps++;
  const after = sample ? await readWeight(state, sample) : null;
  clearPending(state);
  return { steps: state.steps, sample: sample && { ...sample, after, lr, delta: -lr * sample.grad } };
}

async function readWeight(state, sample) {
  const { tf } = state;
  const v = state.vars.find((candidate) => candidate.name === sample.variable);
  if (!v) return null;
  const packed = tf.tidy(() => tf.reshape(tf.gather(tf.reshape(v, [-1]), tf.scalar(sample.index, 'int32')), []));
  const value = (await packed.data())[0];
  packed.dispose();
  return value;
}

function clearPending(state) {
  if (!state || !state.pending) return;
  for (const g of Object.values(state.pending.grads)) if (g) g.dispose();
  state.pending = null;
}

export function reset(state) {
  clearPending(state);
  // setWeights assigns the values across; the snapshot tensors stay ours and
  // stay valid, so this can be called any number of times.
  state.model.setWeights(state.snapshot);
  state.steps = 0;
}

export function dispose(state) {
  if (!state) return;
  clearPending(state);
  if (state.x) state.x.dispose();
  for (const t of state.snapshot) t.dispose();
  state.model.dispose();
  state.x = null;
  state.snapshot = [];
}
