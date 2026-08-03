import * as THREE from 'three';
import { scene } from './scene.js';
// Read through `road` rather than destructuring: it's mutated in place on a
// world switch, so pulling `centers`/`width` out into locals here would
// pin this module to whichever world happened to load first.
import { road } from './world.js';
import { input } from './input.js';
import { tubTrimLastSeconds } from '../data/tub.js';
import { pilot } from '../train/autopilot.js';

// ---------- car ----------
export const car = new THREE.Group();
const frontWheels = [];
{
  const bodyM = new THREE.MeshLambertMaterial({color:0x3b6fd4});
  const darkM = new THREE.MeshLambertMaterial({color:0x20242e});
  const accentM = new THREE.MeshLambertMaterial({color:0xff6a2b}); // matches the --cone accent
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.32, 1.7), bodyM);
  body.position.y = 0.34; body.castShadow = true;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.24, 0.7), darkM);
  cab.position.set(0, 0.6, -0.12); cab.castShadow = true;
  // camera mast (donkey-style)
  const mast = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.34, 0.08), darkM);
  mast.position.set(0, 0.86, 0.28);
  const camBox = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.14), accentM);
  camBox.position.set(0, 1.04, 0.3);
  const wheelG = new THREE.CylinderGeometry(0.19, 0.19, 0.16, 12);
  wheelG.rotateZ(Math.PI/2);
  // Front wheels (+z, same side as the mast/camera) get their own group so
  // they can yaw with V.steer independent of their own roll axis; rear
  // wheels don't steer, so they stay plain meshes parented to the car.
  const frontPos = [[-0.46,0.19,0.55],[0.46,0.19,0.55]];
  const rearPos = [[-0.46,0.19,-0.62],[0.46,0.19,-0.62]];
  for (const [x,y,z] of frontPos) {
    const w = new THREE.Mesh(wheelG, darkM);
    w.castShadow = true;
    const group = new THREE.Group();
    group.position.set(x,y,z);
    group.add(w);
    car.add(group);
    frontWheels.push(group);
  }
  for (const [x,y,z] of rearPos) {
    const w = new THREE.Mesh(wheelG, darkM);
    w.position.set(x,y,z); w.castShadow = true;
    car.add(w);
  }
  car.add(body, cab, mast, camBox);
}
scene.add(car);

// ---------- vehicle physics (kinematic bicycle, fixed 50 Hz) ----------
export const V = {
  x:0, z:0, heading:0, speed:0, steer:0,
  L: 1.2,                 // wheelbase (m)
  MAX_STEER: 0.42,        // rad (~24°)
  STEER_RATE: 3.4,        // rad/s toward target
  ACCEL: 7.5,             // m/s² at full throttle
  BRAKE: 12.0,
  DRAG: 0.32, ROLL: 0.9,
  TOP: 13.5,              // ~49 km/h
  GRIP_V: 8.5             // speed where steering starts to wash out
};
// Incremented whenever a controller deliberately relocates the vehicle.
// Render interpolation must not blend across those discontinuities.
export let poseVersion = 0;

// nearest-center tracking (local search around last index)
export let nearestIdx = road.startIdx;
function updateNearest() {
  const { SAMPLES, centers } = road;
  // `from` is the fixed centre of the search window and must stay fixed:
  // scanning relative to `best` while `best` is being reassigned inside
  // the loop slides the window forward with every improvement, so it walks
  // away from the car instead of bracketing it. Also clamped into range,
  // since a world switch can hand us an index from a longer road.
  const from = nearestIdx % SAMPLES;
  let best = from, bd = Infinity;
  for (let o = -30; o <= 30; o++) {
    const i = (from + o + SAMPLES) % SAMPLES;
    const dx = centers[i].x - V.x, dz = centers[i].z - V.z;
    const d = dx*dx + dz*dz;
    if (d < bd) { bd = d; best = i; }
  }
  nearestIdx = best;
  return Math.sqrt(bd);
}

// Snaps to the given sample, aligned with the road. Shared by resetCar()
// (nearest sample) and resetCarToStart() (the start/finish line).
function placeAtSample(idx) {
  const c = road.centers[idx], t = road.tangents[idx];
  V.x = c.x; V.z = c.z;
  V.heading = Math.atan2(t.x, t.z);
  V.speed = 0; V.steer = 0;
  nearestIdx = idx;
  cte = 0;
  offTrack = false;
  wasOffTrack = false;
  poseVersion++;
}

export function resetCar() {
  // snap to nearest center point, aligned with track
  const { SAMPLES, centers } = road;
  let best = 0, bd = Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const dx = centers[i].x - V.x, dz = centers[i].z - V.z;
    const d = dx*dx + dz*dz;
    if (d < bd) { bd = d; best = i; }
  }
  placeAtSample(best);
}

// Used on a world switch: the car's old coordinates mean nothing on a new
// road (they can land anywhere, including inside the new road's scenery),
// so it goes to the start/finish line rather than to whatever sample of
// the new road happens to be nearest its stale position.
export function resetCarToStart() {
  placeAtSample(road.startIdx);
}

// ---------- fixed-step sim ----------
export const DT = 1/50;
export let cte = 0, offTrack = false, throttleVis = 0, simTime = 0;
let wasOffTrack = false;

// Initial pose. Deliberately down here rather than up beside the V
// declaration: resetCarToStart() writes cte/offTrack/wasOffTrack, which
// are `let` bindings declared just above -- calling it any earlier in the
// module body hits their temporal dead zone.
resetCarToStart();

// How far past the road edge counts as off. A margin, not a half-width, so
// it scales with whatever road is live.
const OFF_TRACK_MARGIN = 0.15;
function offTrackLimit() { return road.width / 2 + OFF_TRACK_MARGIN; }

// Teleports the car to an arbitrary pose relative to track sample `idx` --
// unlike resetCar() (which always snaps onto the centerline), this can
// place it off-line and facing any direction on purpose. Used by
// recovery.js to spawn poses a human driver wouldn't produce on their own,
// then let a recovery controller correct back onto the track.
export function placeCarAt(idx, lateralOffset, headingOffset) {
  const c = road.centers[idx], t = road.tangents[idx], n = road.normalAt(idx);
  V.x = c.x + n.x * lateralOffset;
  V.z = c.z + n.z * lateralOffset;
  V.heading = Math.atan2(t.x, t.z) + headingOffset;
  V.speed = 0;
  V.steer = 0;
  nearestIdx = idx;
  cte = Math.abs(lateralOffset);
  offTrack = cte > offTrackLimit();
  wasOffTrack = offTrack;
  poseVersion++;
}

// Lets recovery.js suspend the off-track auto-reset below for the
// duration of its episodes -- that mode drives off-track on purpose, and
// the auto-reset would otherwise snap the car back before its own
// recovery controller got a chance to correct it. Restored once recovery
// mode stops (see recovery.js).
export let autoResetOnOffTrack = true;
export function setAutoResetOnOffTrack(v) { autoResetOnOffTrack = v; }

export function step(dt) {
  // steering: rate-limited toward target, washed out with speed
  const target = input.steer * V.MAX_STEER;
  const dS = target - V.steer;
  const maxD = V.STEER_RATE * dt;
  V.steer += Math.max(-maxD, Math.min(maxD, dS));
  for (const w of frontWheels) w.rotation.y = V.steer;

  // longitudinal
  let a = 0;
  if (input.throttle > 0) a += input.throttle * V.ACCEL;
  if (input.throttle < 0) a += input.throttle * (V.speed > 0.3 ? V.BRAKE : V.ACCEL * 0.55); // brake, then reverse
  a -= V.DRAG * V.speed + V.ROLL * Math.sign(V.speed);
  if (offTrack) a -= 2.2 * V.speed * dt * 50 * 0.04 + 1.6; // grass drag
  V.speed += a * dt;
  V.speed = Math.max(-V.TOP*0.35, Math.min(V.TOP, V.speed));
  if (Math.abs(input.throttle) < 0.02 && Math.abs(V.speed) < 0.25) V.speed = 0;
  throttleVis = input.throttle;

  // steering wash-out at speed (understeer feel without a tire model)
  const wash = 1 / (1 + Math.pow(Math.max(V.speed,0) / V.GRIP_V, 2) * 0.55);
  const steerEff = V.steer * wash;

  // bicycle update
  V.heading += (V.speed / V.L) * Math.tan(steerEff) * dt;
  V.x += Math.sin(V.heading) * V.speed * dt;
  V.z += Math.cos(V.heading) * V.speed * dt;

  const dist = updateNearest();
  cte = dist;
  offTrack = dist > offTrackLimit();
  simTime += dt;

  // Going off-track ends the recording (the gating in the record loop
  // already stops capturing new frames once offTrack is true), but the
  // run of frames leading up to it -- the mistake that caused it -- is
  // bad training data, so drop the last few seconds, put the car back on
  // the line, and zero the throttle so it doesn't immediately drive off
  // again.
  if (offTrack && !wasOffTrack && autoResetOnOffTrack) {
    // No trim during autopilot: those laps were never recorded, so the
    // trim would eat the tail of the user's manual data instead. The
    // reset still applies -- the model gets put back on the line to try
    // again (throttle zeroing is moot there; the next prediction
    // reapplies it, which is what "watch it fail and retry" wants).
    if (!pilot.active) tubTrimLastSeconds(3, simTime);
    resetCar();
    input.throttle = 0;
    cte = 0;
    offTrack = false;
  }
  wasOffTrack = offTrack;
}
