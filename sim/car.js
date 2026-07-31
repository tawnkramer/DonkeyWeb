import * as THREE from 'three';
import { scene } from './scene.js';
import { SAMPLES, TRACK_W, START_IDX, centers, tangents } from './track.js';
import { input } from './input.js';
import { tubTrimLastSeconds } from '../data/tub.js';

// ---------- car ----------
export const car = new THREE.Group();
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
  const wpos = [[-0.46,0.19,0.55],[0.46,0.19,0.55],[-0.46,0.19,-0.62],[0.46,0.19,-0.62]];
  for (const [x,y,z] of wpos) {
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

// nearest-center tracking (local search around last index)
export let nearestIdx = START_IDX;
function updateNearest() {
  let best = nearestIdx, bd = Infinity;
  for (let o = -30; o <= 30; o++) {
    const i = (nearestIdx + o + SAMPLES) % SAMPLES;
    const dx = centers[i].x - V.x, dz = centers[i].z - V.z;
    const d = dx*dx + dz*dz;
    if (d < bd) { bd = d; best = i; }
  }
  nearestIdx = best;
  return Math.sqrt(bd);
}

export function resetCar() {
  // snap to nearest center point, aligned with track
  let best = 0, bd = Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const dx = centers[i].x - V.x, dz = centers[i].z - V.z;
    const d = dx*dx + dz*dz;
    if (d < bd) { bd = d; best = i; }
  }
  const c = centers[best], t = tangents[best];
  V.x = c.x; V.z = c.z;
  V.heading = Math.atan2(t.x, t.z);
  V.speed = 0; V.steer = 0;
  nearestIdx = best;
}
V.x = centers[START_IDX].x; V.z = centers[START_IDX].z;
V.heading = Math.atan2(tangents[START_IDX].x, tangents[START_IDX].z);

// ---------- fixed-step sim ----------
export const DT = 1/50;
export let cte = 0, offTrack = false, throttleVis = 0, simTime = 0;
let wasOffTrack = false;

export function step(dt) {
  // steering: rate-limited toward target, washed out with speed
  const target = input.steer * V.MAX_STEER;
  const dS = target - V.steer;
  const maxD = V.STEER_RATE * dt;
  V.steer += Math.max(-maxD, Math.min(maxD, dS));

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
  offTrack = dist > TRACK_W/2 + 0.15;
  simTime += dt;

  // Going off-track ends the recording (the gating in the record loop
  // already stops capturing new frames once offTrack is true), but the
  // run of frames leading up to it -- the mistake that caused it -- is
  // bad training data, so drop the last few seconds, put the car back on
  // the line, and zero the throttle so it doesn't immediately drive off
  // again.
  if (offTrack && !wasOffTrack) {
    tubTrimLastSeconds(3, simTime);
    resetCar();
    input.throttle = 0;
    cte = 0;
    offTrack = false;
  }
  wasOffTrack = offTrack;
}
