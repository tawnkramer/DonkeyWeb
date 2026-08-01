// Autopilot inference (plan §2.4): the trained model runs on the main
// thread in the render loop -- a KerasLinear forward pass at 160x120 is a
// few ms, well within the 20 Hz control budget, and unlike training it
// needs its result synchronously for the next physics tick. tfjs is
// dynamically imported on first use so the sim's <10s startup goal never
// pays the ~1.5 MB module parse; this is a second tf instance separate
// from the training worker's, which is why train/model.js takes tf as a
// parameter.
import {
  ensureModelMetadata, getActiveModelId, getModel, listModels, modelLoadUrl,
  setActiveModelId, BUILTIN_MODEL,
} from './models.js';
import { buildModel } from './model.js';

export const pilot = {
  active: false,   // model is driving the car
  ready: false,    // a model is loaded and warmed up
  loading: false,
  steer: 0,        // latest prediction, sim convention (+1 = full left)
  throttle: 0,
  predCount: 0,
  error: null,     // last load failure ("no model yet" is the normal case)
  modelId: null,
  modelName: '',
};

let tf = null;
let model = null;
let inputH = 0, inputW = 0;   // read off the loaded model, see loadPilotModel

async function ensureTf() {
  if (!tf) tf = await import('../vendor/tf.mjs');
  try {
    await tf.ready();
  } catch {
    // Some browsers expose a partial WebGPU API without an adapter. In that
    // case tf.ready() can reject before it reaches its normal WebGL fallback.
    // Eval is small enough to use WebGL or CPU as a reliable fallback.
    try { await tf.setBackend('webgl'); } catch { await tf.setBackend('cpu'); }
    await tf.ready();
  }
}

const modelListeners = new Set();
export function onPilotModelChange(fn) { modelListeners.add(fn); }
function emitModelChange() { for (const fn of modelListeners) fn(pilot.modelId); }

export async function getAvailableModels() {
  await ensureTf();
  await ensureModelMetadata(tf);
  return listModels();
}

export async function loadPilotModel(requestedId) {
  if (pilot.loading) return pilot.ready;
  pilot.loading = true;
  try {
    await ensureTf();
    await ensureModelMetadata(tf);
    const models = await listModels();
    const storedActive = localStorage.getItem('donkeyweb-active-model');
    // A first-run browser with one legacy model should keep that model as the
    // active user model. Once a user explicitly chooses the built-in example,
    // the persisted selection wins on subsequent reloads.
    const implicitDefault = requestedId === undefined && !storedActive && models.length === 2
      ? models.find(model => model.kind === 'user')?.id
      : undefined;
    const selected = await getModel(requestedId || implicitDefault || getActiveModelId()) || BUILTIN_MODEL;
    if (!selected) throw new Error('model not found');
    const next = selected.kind === 'builtin'
      ? selected.installed
        ? await tf.loadLayersModel(selected.url)
        : buildBuiltinModel(tf, selected.profile)
      : await tf.loadLayersModel(modelLoadUrl(selected));
    // The model states its own input size (the tiny profile trains at
    // 64x64, the donkeycar clone at 120x160), so inference reads it off the
    // loaded model rather than assuming the POV canvas's size. A model
    // trained at one size then drives correctly with no other coordination.
    const [, h, w] = next.inputs[0].shape;
    inputH = h; inputW = w;
    // Warm up now so the first shader compile doesn't hitch the sim the
    // moment autopilot is toggled on.
    tf.tidy(() => next.predict(tf.zeros([1, inputH, inputW, 3])));
    if (model) model.dispose();
    model = next;
    pilot.ready = true;
    pilot.error = null;
    pilot.modelId = selected.id;
    pilot.modelName = selected.name;
    if (requestedId !== undefined || selected.kind !== 'builtin') setActiveModelId(selected.id);
    emitModelChange();
  } catch (err) {
    // Usually just "no model in IndexedDB yet" -- recorded quietly so the
    // UI can disable the button rather than spamming the console.
    pilot.error = String((err && err.message) || err);
  } finally {
    pilot.loading = false;
  }
  return pilot.ready;
}

// A deterministic website example: it holds a centered steering command and
// a gentle throttle, enough to demonstrate the complete Eval loop without
// creating a mutable IndexedDB model. The model architecture is the same as
// user-trained models, so input sizing and prediction paths are exercised.
function buildBuiltinModel(tf, profile) {
  const next = buildModel(tf, profile);
  for (const layer of next.layers) {
    const weights = layer.getWeights();
    if (!weights.length) continue;
    const replacement = weights.map(weight => tf.zerosLike(weight));
    layer.setWeights(replacement);
    replacement.forEach(weight => weight.dispose());
  }
  const throttle = next.getLayer('n_outputs1');
  const [kernel] = throttle.getWeights();
  throttle.setWeights([kernel, tf.tensor1d([0.25])]);
  return next;
}

// Same registration pattern as input.js's onReset, for the same reason:
// this module can't import car.js (car.js already imports pilot for the
// off-track trim guard), so whoever wires the sim decides what "autopilot
// switched off" does to the car.
let deactivateCallback = null;
export function onPilotDeactivate(cb) { deactivateCallback = cb; }

export function setPilotActive(on) {
  const wasActive = pilot.active;
  pilot.active = !!on && pilot.ready;
  if (wasActive && !pilot.active && deactivateCallback) deactivateCallback();
  return pilot.active;
}

// Called at 20 Hz with the freshly rendered POV ImageData -- the same
// frames that trained the model, which is the whole point.
export function pilotPredict(imageData) {
  if (!pilot.ready) return;
  const [steer, throttle] = tf.tidy(() => {
    let x = tf.browser.fromPixels(imageData, 3).div(255).expandDims(0);
    // Downscale to whatever the model was trained at. Bilinear on the GPU
    // in the same tidy as the forward pass, so a 64x64 model costs one
    // extra op rather than a canvas round trip in the 20 Hz control loop.
    if (imageData.height !== inputH || imageData.width !== inputW) {
      x = tf.image.resizeBilinear(x, [inputH, inputW]);
    }
    const [s, t] = model.predict(x);
    return [s.dataSync()[0], t.dataSync()[0]];
  });
  pilot.steer = Math.max(-1, Math.min(1, steer));
  // Throttle floor at 0: recorded throttle is always positive (recording
  // gates on throttle > 0), so a negative prediction is extrapolation
  // noise, not a braking skill the model could have learned.
  pilot.throttle = Math.max(0, Math.min(1, throttle));
  pilot.predCount++;
}
