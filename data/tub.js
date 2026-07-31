import { povCanvas } from '../sim/scene.js';

// ---------- recording (tub) ----------
// In-memory for now; frames get an IndexedDB-backed home once this
// capture/trim/reset control logic is solid. steer/throttle are recorded
// as the raw driver-commanded values (matching what a real donkeycar tub
// records -- the PWM command, not the resulting vehicle state), which is
// also what's already continuous thanks to mouse/wheel input.
export const tub = { frames: [] };

export function tubPush(t, steer, throttle) {
  tub.frames.push({ t, steer, throttle, img: povCanvas.toDataURL('image/jpeg', 0.7) });
}

export function tubTrimLastSeconds(seconds, simTime) {
  const cutoff = simTime - seconds;
  while (tub.frames.length && tub.frames[tub.frames.length - 1].t > cutoff) tub.frames.pop();
}
