// Autopilot inference (plan §2.4): the trained model runs on the main
// thread in the render loop -- a KerasLinear forward pass at 160x120 is a
// few ms, well within the 20 Hz control budget, and unlike training it
// needs its result synchronously for the next physics tick. tfjs is
// dynamically imported on first use so the sim's <10s startup goal never
// pays the ~1.5 MB module parse; this is a second tf instance separate
// from the training worker's, which is why train/model.js takes tf as a
// parameter.
export const pilot = {
  active: false,   // model is driving the car
  ready: false,    // a model is loaded and warmed up
  loading: false,
  steer: 0,        // latest prediction, sim convention (+1 = full left)
  throttle: 0,
  predCount: 0,
  error: null,     // last load failure ("no model yet" is the normal case)
};

let tf = null;
let model = null;
let inputH = 0, inputW = 0;   // read off the loaded model, see loadPilotModel

export async function loadPilotModel() {
  if (pilot.loading) return pilot.ready;
  pilot.loading = true;
  try {
    if (!tf) {
      tf = await import('../vendor/tf.mjs');
      await tf.ready();
    }
    const next = await tf.loadLayersModel('indexeddb://donkeyweb-model');
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
  } catch (err) {
    // Usually just "no model in IndexedDB yet" -- recorded quietly so the
    // UI can disable the button rather than spamming the console.
    pilot.error = String((err && err.message) || err);
  } finally {
    pilot.loading = false;
  }
  return pilot.ready;
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
