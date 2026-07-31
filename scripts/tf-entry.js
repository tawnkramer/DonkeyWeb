// Entry point for the vendored tfjs bundle (see scripts/vendor.sh).
// The webgpu backend is bundled INTO the same file rather than as a
// second bundle: bundled separately it would carry its own copy of
// tfjs-core and register the webgpu backend on that instance instead of
// ours. Importing it is side-effect registration only -- backends are
// only initialized on tf.setBackend(), so shipping it costs nothing on
// browsers without WebGPU.
export * from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgpu';
