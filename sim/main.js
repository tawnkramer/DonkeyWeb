import * as THREE from 'three';
import { renderer, scene, chaseCam, povCam, povTarget, povPixels, povCtx, povImage, POV_W, POV_H } from './scene.js';
import './track.js';
import './scenery.js';
import { car, V, step, DT, resetCar, offTrack, simTime, cte } from './car.js';
import { input, onReset } from './input.js';
import { tub, tubPush } from '../data/tub.js';
import { drawHud, setFps, drawDataset } from './hud.js';

onReset(resetCar);

// Lightweight console/debug hook -- ES module state is private to its
// module (unlike the old single-file version's classic <script>, where
// every top-level const/let shared one global scope), so this is the
// supported way to poke at live sim state from devtools. Getters, not
// plain values, so offTrack/simTime/cte reflect the current tick rather
// than whatever they were when this object was built.
window.__sim = {
  input, V, tub, scene,
  get offTrack() { return offTrack; },
  get simTime() { return simTime; },
  get cte() { return cte; },
};

// ---------- cameras ----------
// Physics runs in fixed 20ms (50Hz) ticks, but rendering happens once per
// requestAnimationFrame at whatever rate the display refreshes (commonly
// 60Hz+). Those don't divide evenly, so the number of physics ticks per
// rendered frame alternates between 0, 1 and occasionally 2 -- placing the
// camera directly at the latest tick's position made it visibly judder at
// that beat frequency. rx/rz/rHeading are the car's pose interpolated
// between the previous and current physics tick by how far into the next
// tick this render falls, which removes the judder without changing the
// physics itself.
function placeCameras(rx, rz, rHeading) {
  car.position.set(rx, 0, rz);
  car.rotation.y = rHeading;

  // chase cam: damped follow
  const back = 6.4, up = 3.0;
  const tx = rx - Math.sin(rHeading)*back;
  const tz = rz - Math.cos(rHeading)*back;
  chaseCam.position.lerp(new THREE.Vector3(tx, up, tz), 0.08);
  chaseCam.lookAt(rx, 0.8, rz);

  // POV cam: on the mast, pitched slightly down (donkey-style)
  const fx = rx + Math.sin(rHeading)*0.32;
  const fz = rz + Math.cos(rHeading)*0.32;
  povCam.position.set(fx, 1.05, fz);
  povCam.rotation.set(0, rHeading + Math.PI, 0);
  povCam.rotateX(-0.20);
}

// ---------- main loop ----------
let last = performance.now(), acc = 0;
let fpsA = 60;
let prevX = V.x, prevZ = V.z, prevHeading = V.heading;
const REC_DT = 1/20;
let recAcc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  fpsA += (1/Math.max(dt,1e-4) - fpsA) * 0.05;

  acc += dt;
  while (acc >= DT) {
    prevX = V.x; prevZ = V.z; prevHeading = V.heading;
    step(DT);
    acc -= DT;
  }

  const rAlpha = acc / DT;
  placeCameras(prevX + (V.x - prevX) * rAlpha,
               prevZ + (V.z - prevZ) * rAlpha,
               prevHeading + (V.heading - prevHeading) * rAlpha);

  // main view
  renderer.setRenderTarget(null);
  renderer.render(scene, chaseCam);

  // POV → 160×120 buffer → HUD canvas (this buffer is the future training frame)
  renderer.setRenderTarget(povTarget);
  renderer.render(scene, povCam);
  renderer.readRenderTargetPixels(povTarget, 0, 0, POV_W, POV_H, povPixels);
  // flip vertically (GL origin is bottom-left)
  const d = povImage.data;
  for (let y = 0; y < POV_H; y++) {
    const src = (POV_H - 1 - y) * POV_W * 4;
    d.set(povPixels.subarray(src, src + POV_W*4), y * POV_W * 4);
  }
  povCtx.putImageData(povImage, 0, 0);
  renderer.setRenderTarget(null);

  // record at 20 Hz, independent of render rate, same fixed-step pattern
  // as physics -- only while driving forward and on the track
  const isRecording = input.throttle > 0 && !offTrack;
  recAcc += dt;
  if (recAcc >= REC_DT) {
    recAcc -= REC_DT;
    if (isRecording) tubPush(simTime, input.steer, input.throttle);
  }

  drawHud();
  drawDataset(isRecording);
  setFps(fpsA);
}

// ---------- resize ----------
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  chaseCam.aspect = w / h;
  chaseCam.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// go
chaseCam.position.set(V.x - Math.sin(V.heading)*6.4, 3, V.z - Math.cos(V.heading)*6.4);
requestAnimationFrame(frame);
