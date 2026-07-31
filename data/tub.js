import { povCanvas } from '../sim/scene.js';

// ---------- recording (tub) ----------
// In-memory for now; frames get an IndexedDB-backed home once this
// capture/trim/reset control logic is solid. steer/throttle are recorded
// as the raw driver-commanded values (matching what a real donkeycar tub
// records -- the PWM command, not the resulting vehicle state), which is
// also what's already continuous thanks to mouse/wheel input.

// bins is a live steering histogram over [-1,1], kept in sync incrementally
// on push/trim rather than recomputed from the full frame list every UI
// tick -- cheap now, stays cheap once tubs have thousands of frames.
// steer is +1 = full left, so bin index has to run the other way (low
// index = left) to land left turns on the left side of the display and
// right turns on the right, matching the steering bar elsewhere in the HUD.
export const BINS = 9;
const BIN_WIDTH = 2 / BINS;
function binIndex(steer) {
  return Math.min(BINS - 1, Math.max(0, Math.floor((-steer + 1) / BIN_WIDTH)));
}

export const tub = { frames: [], bins: new Array(BINS).fill(0) };

export function tubPush(t, steer, throttle) {
  tub.frames.push({ t, steer, throttle, img: povCanvas.toDataURL('image/jpeg', 0.7) });
  tub.bins[binIndex(steer)]++;
}

export function tubTrimLastSeconds(seconds, simTime) {
  const cutoff = simTime - seconds;
  while (tub.frames.length && tub.frames[tub.frames.length - 1].t > cutoff) {
    const removed = tub.frames.pop();
    tub.bins[binIndex(removed.steer)]--;
  }
}
