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
export function buildModel(tf) {
  const drop = 0.2;
  const imgIn = tf.input({ shape: [120, 160, 3], name: 'img_in' });

  let x = imgIn;
  const convs = [
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
  x = tf.layers.flatten({ name: 'flattened' }).apply(x);
  x = tf.layers.dense({ units: 100, activation: 'relu', name: 'dense_1' }).apply(x);
  x = tf.layers.dropout({ rate: drop }).apply(x);
  x = tf.layers.dense({ units: 50, activation: 'relu', name: 'dense_2' }).apply(x);
  x = tf.layers.dropout({ rate: drop }).apply(x);

  const steering = tf.layers.dense({ units: 1, activation: 'linear', name: 'n_outputs0' }).apply(x);
  const throttle = tf.layers.dense({ units: 1, activation: 'linear', name: 'n_outputs1' }).apply(x);

  const model = tf.model({ inputs: imgIn, outputs: [steering, throttle], name: 'linear' });
  model.compile({ optimizer: tf.train.adam(), loss: 'meanSquaredError' });
  return model;
}
