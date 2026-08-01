// Exact tfjs clone of donkeycar's KerasLinear (default_n_linear in
// donkeycar/parts/keras.py): 5 convs -> flatten -> dense 100 -> dense 50
// -> two 1-unit linear heads (steering, throttle). Layer names match
// donkeycar's exactly -- that parity is what makes M4's "export weights to
// a real car" a plain weight-copy instead of an architecture conversion,
// and it's why this stays five convs even though something smaller would
// train faster in a browser.
//
// Input is 120x160x3 float in [0,1]; normalization (img/255) happens in
// the data pipeline, not a model layer, matching where donkeycar does it.
//
// Sign convention: the sim records steer as +1 = full LEFT (see
// data/tub.js); donkeycar's convention is +1 = right. The model trains
// and drives consistently in sim convention -- the M4 export script owns
// the negation.
//
// Takes `tf` as a parameter instead of importing it: the training worker
// and the (future, M2) autopilot on the main thread each load their own
// tfjs instance, and a model must be built against the instance that will
// run it.
// Two sizes of the same idea. 'linear' is the donkeycar clone described
// above. 'tiny' is the phone version, and exists because a phone GPU cannot
// hold the full model's activations: one batch of 64 frames at 120x160
// makes the first conv output alone [64,58,78,24] = 28 MB, several of which
// are live at once during backprop, and iOS answers that by killing the
// worker with no error -- training that simply goes quiet forever.
//
// It follows the same shape as the reduced net donkeycar users run on a Pi
// Zero: smaller input, fewer filters, an extra stride instead of depth.
// ~2.4M MACs per image against ~48M, so about 20x less work per batch.
// Resolution is what buys that -- nearly all of it is in the early, large
// feature maps -- so this keeps 3 colour channels (only conv2d_1 pays for
// them, ~0.7M MACs) rather than going mono: on this track, orange cones and
// a yellow lane against green ground are exactly the cue colour carries.
//
// The trained model is self-describing -- everything downstream reads the
// input shape off the model rather than assuming one (see train/autopilot.js)
// -- so both profiles drop into the same record/train/drive loop.
export const PROFILES = {
  linear: { w: 160, h: 120, label: 'KerasLinear · 160×120' },
  tiny:   { w: 64,  h: 64,  label: 'tiny · 64×64' },
};
export const DEFAULT_PROFILE = 'linear';

export function buildModel(tf, profile = DEFAULT_PROFILE) {
  const drop = 0.2;
  const { w, h } = PROFILES[profile] || PROFILES[DEFAULT_PROFILE];
  const imgIn = tf.input({ shape: [h, w, 3], name: 'img_in' });

  let x = imgIn;
  const convs = profile === 'tiny' ? [
    [16, 5, 2, 'conv2d_1'],
    [24, 5, 2, 'conv2d_2'],
    [32, 3, 2, 'conv2d_3'],
    [32, 3, 1, 'conv2d_4'],
  ] : [
    [24, 5, 2, 'conv2d_1'],
    [32, 5, 2, 'conv2d_2'],
    [64, 5, 2, 'conv2d_3'],
    [64, 3, 1, 'conv2d_4'],
    [64, 3, 1, 'conv2d_5'],
  ];
  for (const [filters, kernelSize, strides, name] of convs) {
    x = tf.layers.conv2d({ filters, kernelSize, strides, activation: 'relu', name }).apply(x);
    x = tf.layers.dropout({ rate: drop }).apply(x);
  }
  const dense = profile === 'tiny' ? [64, 32] : [100, 50];
  x = tf.layers.flatten({ name: 'flattened' }).apply(x);
  x = tf.layers.dense({ units: dense[0], activation: 'relu', name: 'dense_1' }).apply(x);
  x = tf.layers.dropout({ rate: drop }).apply(x);
  x = tf.layers.dense({ units: dense[1], activation: 'relu', name: 'dense_2' }).apply(x);
  x = tf.layers.dropout({ rate: drop }).apply(x);

  const steering = tf.layers.dense({ units: 1, activation: 'linear', name: 'n_outputs0' }).apply(x);
  const throttle = tf.layers.dense({ units: 1, activation: 'linear', name: 'n_outputs1' }).apply(x);

  const model = tf.model({ inputs: imgIn, outputs: [steering, throttle], name: profile });
  model.compile({ optimizer: tf.train.adam(), loss: 'meanSquaredError' });
  return model;
}
