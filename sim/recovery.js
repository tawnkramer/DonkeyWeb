import { V, nearestIdx, placeCarAt, setAutoResetOnOffTrack } from './car.js';
import { road } from './world.js';
import { tub, tubTrimToLength } from '../data/tub.js';

// ---------- automatic recovery-data generation ----------
// Recovery footage -- correcting from an off-line pose back onto the
// centerline -- is exactly the data a human rarely produces while driving
// well, but it's what teaches a behavior-cloned model to correct instead
// of just diverging further the first time it drifts. This mode automates
// collecting it: teleport the car to a random off-line pose (poses a
// careful driver wouldn't hit on their own), drive it back with a Stanley
// controller (steer = heading-error + atan(k * cross-track-error / speed),
// the standard feedback law for exactly this "get back on the path"
// problem), record only the correction itself, then repeat with a new
// random pose. See car.js's placeCarAt/autoResetOnOffTrack for how the
// normal off-track auto-reset is suspended while this runs.

const STANLEY_K = 1.6;          // cross-track gain
const MIN_SPEED = 1.2;          // m/s floor in the Stanley denominator -- avoids a singularity near v=0
// car.js's grass drag (see step()) subtracts a flat ~1.6 m/s^2 whenever
// offTrack is true, on top of drag/rolling resistance -- and perturbations
// routinely start off-track on purpose. A throttle below roughly 0.33
// nets negative acceleration out there and the car just stalls in the
// grass, steering maxed out but essentially motionless. 0.55 clears that
// with margin (verified against car.js's exact physics: worst-case, a
// near-reversed heading at max offset, still recovers in ~7.5s against a
// 14s episode timeout).
const THROTTLE = 0.55;
const SUCCESS_LAT = 0.5;        // m of lateral error counted as "back on line"
const SUCCESS_HEADING = 0.12;   // rad (~7deg)
const SUCCESS_DWELL = 0.3;      // s the success condition must hold before ending the episode
const EPISODE_TIMEOUT = 14;     // s; a stuck/failed recovery is abandoned and its frames dropped
// Fractions of the live road width, not absolute metres: "just past the
// edge" and "well onto the grass" have to mean the same thing on a 5m
// canyon road as on a 9m speedway, or recovery episodes on a narrow world
// would all start implausibly far out.
const OFFSET_MIN_FRAC = 0.3;    // just past the road edge (edge is at 0.5)
const OFFSET_MAX_FRAC = 0.75;   // well onto the shoulder
const HEADING_SPREAD = 2.3;     // rad, up to ~130 degrees off the track direction either way

export const recovery = {
  active: false,
  phase: 'idle',   // idle | recovering
  steer: 0, throttle: 0,
  episodes: 0, successes: 0,
  frames: 0,        // frames recorded so far in the CURRENT episode
};

let dwell = 0, episodeTime = 0, episodeStartFrames = 0;

function randRange(a, b) { return a + Math.random() * (b - a); }

function normalizeAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

function newPerturbation() {
  const idx = Math.floor(Math.random() * road.SAMPLES);
  const side = Math.random() < 0.5 ? -1 : 1;
  const lateral = side * randRange(road.width * OFFSET_MIN_FRAC, road.width * OFFSET_MAX_FRAC);
  const heading = randRange(-HEADING_SPREAD, HEADING_SPREAD);
  placeCarAt(idx, lateral, heading);
  recovery.phase = 'recovering';
  dwell = 0;
  episodeTime = 0;
  episodeStartFrames = tub.frames.length;
  recovery.frames = 0;
  recovery.episodes++;
}

export function startRecovery() {
  if (recovery.active || road.graph) return false;
  recovery.active = true;
  setAutoResetOnOffTrack(false);
  newPerturbation();
  return true;
}

// Same registration pattern as input.js's onReset and autopilot.js's
// onPilotDeactivate: recovery.js can't import car.js's resetCar/input
// without risking a cycle back through car.js -> recovery.js's own
// autoResetOnOffTrack import, so whoever wires the sim decides what
// "recovery generation switched off" does to the car.
let deactivateCallback = null;
export function onRecoveryDeactivate(cb) { deactivateCallback = cb; }

export function stopRecovery() {
  if (!recovery.active) return;
  recovery.active = false;
  recovery.phase = 'idle';
  setAutoResetOnOffTrack(true);
  if (deactivateCallback) deactivateCallback();
}

// Called once per rendered frame while recovery is active -- same pattern
// as autopilot's pilotPredict: it reads the car's pose as of the end of
// the previous physics tick and writes recovery.steer/throttle, which
// main.js then copies into input.* right before the next physics step.
export function stepRecovery(dt) {
  if (!recovery.active) return;

  const idx = nearestIdx;
  const c = road.centers[idx], t = road.tangents[idx], n = road.normalAt(idx);
  const trackHeading = Math.atan2(t.x, t.z);
  const headingError = normalizeAngle(trackHeading - V.heading);
  const eLat = (V.x - c.x) * n.x + (V.z - c.z) * n.z;

  const crossTrackTerm = Math.atan2(STANLEY_K * eLat, Math.max(Math.abs(V.speed), MIN_SPEED));
  const steerCmd = headingError + crossTrackTerm;
  recovery.steer = Math.max(-1, Math.min(1, steerCmd / V.MAX_STEER));
  recovery.throttle = THROTTLE;

  episodeTime += dt;
  const onLine = Math.abs(eLat) < SUCCESS_LAT && Math.abs(headingError) < SUCCESS_HEADING;
  dwell = onLine ? dwell + dt : 0;
  recovery.frames = tub.frames.length - episodeStartFrames;

  if (dwell >= SUCCESS_DWELL) {
    recovery.successes++;
    newPerturbation();
  } else if (episodeTime >= EPISODE_TIMEOUT) {
    // Couldn't recover in time -- this episode's frames teach the wrong
    // lesson (drifting further, not correcting), so drop them rather than
    // let them into the tub.
    tubTrimToLength(episodeStartFrames);
    newPerturbation();
  }
}
