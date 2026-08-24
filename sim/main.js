import * as THREE from 'three';
import { renderer, canvas, scene, chaseCam, povCam, povTarget, povPixels, povCtx, povImage, POV_W, POV_H,
         isGLAvailable } from './scene.js';
import { road, collision, setWorld, listWorlds, getWorldId, onWorldChange, stepWorld, stepWorldFixed, featureStates } from './world.js';
import { hitTest } from './collide.js';
import { car, V, step, DT, resetCar, resetCarToStart, placeCarAt, offTrack, simTime, cte, poseVersion } from './car.js';
import { input, source, onReset } from './input.js';
import { gamepad, pollGamepads } from './gamepad.js';
import { tub, tubPush, loadTub } from '../data/tub.js';
import { requestPersistence, storageEstimate } from '../data/db.js';
import { drawHud, setFps } from './hud.js';
import { training, trainStart, trainStop } from '../train/trainer.js';
import { pilot, pilotPredict, setPilotActive, loadPilotModel, getAvailableModels, onPilotDeactivate } from '../train/autopilot.js';
import { recovery, startRecovery, stopRecovery, stepRecovery, onRecoveryDeactivate } from './recovery.js';
import { getMode, setMode, onModeChange } from './mode.js';
import './navui.js';
import './modelui.js';
import './worldui.js';
import './joystick.js';
import './trainui.js';
import { learn } from './learnui.js';
import { drawPilot } from './pilotui.js';
import { drawRecover } from './recoverui.js';
import { drawDataset, syncDataAvailability } from './datasetui.js';
import { drawRecordButton, onStopRecording } from './recordui.js';

// A reset means "back on the line, standing still": killing the throttle
// belongs with it, or the car immediately drives off again on whatever
// throttle was held (the user's scroll level after R, or the model's last
// prediction after switching autopilot off).
function resetToLine() {
  resetCar();
  input.throttle = 0;
}
onReset(resetToLine);
onPilotDeactivate(resetToLine);
onRecoveryDeactivate(resetToLine);
onStopRecording(() => stopSession());

// Leaving both driving screens (Drive/Eval) while autopilot is engaged
// auto-stops it -- otherwise it'd keep "driving" in the background on a
// frozen last prediction indefinitely. Reuses the existing
// onPilotDeactivate -> resetToLine() hook above; switching directly
// between Drive and Eval does NOT trigger this, both are the same
// continuous driving context. Leaving Recover stops the generator the
// same way, via onRecoveryDeactivate -> resetToLine() above.
onModeChange(next => {
  if (next !== 'drive' && next !== 'eval' && pilot.active) setPilotActive(false);
  if (next !== 'recover' && recovery.active) stopRecovery();
  // Arriving on a driving screen repaints even if the car never moved:
  // rendering is gated on being on one of these screens, so a world
  // switched from Data/Train would otherwise burn its wake while nothing
  // was drawing and leave the stale world on screen.
  if (next === 'drive' || next === 'eval' || next === 'recover') wakeRender();
});

// Switching worlds puts the car on the new start line, stopped. Recovery
// generation is stopped outright rather than carried over: an episode is
// scored against the road it started on (its perturbation index and
// success thresholds), so letting one straddle a world swap would file
// frames from the new road under the old episode. Autopilot is left
// running on purpose -- "load a model, then try it on a track it never
// saw" is exactly the cross-world generalization check worlds are for.
onWorldChange(() => {
  if (recovery.active) stopRecovery();   // -> resetToLine via onRecoveryDeactivate
  resetCarToStart();
  input.throttle = 0;
  wakeRender();
});

// Not awaited: the sim starts driving immediately (recording just stays
// paused via tub.loaded until this resolves) rather than blocking the
// "drivable in under 10 seconds" startup goal on an IndexedDB round trip.
loadTub();

// Asked for at startup rather than at first record, because the answer has to
// be in place before there is anything worth losing. Not awaited either: it
// changes nothing about how the page runs, only whether the browser considers
// the recorded laps disposable when the disk gets tight.
requestPersistence();

// Lightweight console/debug hook -- ES module state is private to its
// module (unlike the old single-file version's classic <script>, where
// every top-level const/let shared one global scope), so this is the
// supported way to poke at live sim state from devtools. Getters, not
// plain values, so offTrack/simTime/cte reflect the current tick rather
// than whatever they were when this object was built.
window.__sim = {
  input, source, gamepad, pollGamepads,
  V, tub, scene, training, trainStart, trainStop,
  pilot, setPilotActive, loadPilotModel, getMode, setMode,
  getAvailableModels, recovery, startRecovery, stopRecovery,
  road, setWorld, listWorlds, getWorldId, featureStates,
  // Writing V.x/V.z from the console looks like it should work and does
  // not: nearestIdx only ever moves by a local search, so a hand-written
  // teleport leaves it stale, the cross-track error reads as enormous and
  // the off-track auto-reset immediately undoes the move. Go through this.
  placeCarAt, resetCarToStart, collision, hitTest,
  stopSession, storageEstimate, learn,
  get sessionOpen() { return sessionOpen; },
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

// Exponential decay rate for the chase cam's follow, in 1/s -- framerate-
// independent (unlike a flat per-frame lerp factor, which implicitly
// assumes a fixed tick rate) and tuned a bit gentler than before: autopilot's
// predictions land at a fixed 20 Hz and get held between renders (a mild
// staircase versus a mouse's continuous motion), which read as noticeable
// jitter in the follow cam at the old, snappier damping.
const CHASE_FOLLOW_RATE = 3.5;

function placeCameras(rx, rz, rHeading, dt, snap = false) {
  car.position.set(rx, 0, rz);
  car.rotation.y = rHeading;

  // chase cam: damped follow
  const back = 6.4, up = 3.0;
  const tx = rx - Math.sin(rHeading)*back;
  const tz = rz - Math.cos(rHeading)*back;
  const followT = 1 - Math.exp(-CHASE_FOLLOW_RATE * dt);
  if (snap) chaseCam.position.set(tx, up, tz);
  else chaseCam.position.lerp(new THREE.Vector3(tx, up, tz), followT);
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
let seenPoseVersion = poseVersion;
const REC_DT = 1/20;
let recAcc = 0;

// ---------- driving sessions (what counts as recordable) ----------
// This used to be a flat `input.throttle > 0`, which cannot record a stop.
// Every frame where the driver lifts off or holds still is dropped, so the
// tub ends up containing no example of throttle <= 0 anywhere -- and a
// behaviour-cloned model that has never seen a zero-throttle label has no
// way to produce one. It structurally cannot learn to stop, which is
// exactly the behaviour the city world's traffic lights exist to teach.
//
// So a session opens the moment the user drives and stays open through
// lifting off, braking, and sitting at a red -- all of which are the
// lesson, not gaps in it. SESSION_IDLE_S is what keeps a car parked and
// forgotten from flooding the tub with thousands of identical frames: the
// wait at a signal gets recorded, an abandoned session does not. Pulling
// away reopens the session on the first throttle input, so the green-light
// launch is captured from its first frame.
const SESSION_IDLE_S = 4;
let sessionOpen = false, sessionIdleDt = 0;
// Set by the stop-recording button. Without it the button would do
// nothing whenever the throttle is still held: updateSession() would just
// reopen the session on the very next frame. Cleared as soon as the
// driver lifts off, so the next pull-away starts a fresh take.
let sessionSuppressed = false;

function stopSession() {
  sessionOpen = false;
  sessionIdleDt = 0;
  sessionSuppressed = true;
}

function updateSession(dt, mode) {
  // Only manual driving in Drive mode is a session at all -- autopilot is
  // the model's own output, and the other screens aren't driving.
  if (mode !== 'drive' || pilot.active) {
    sessionOpen = false;
    sessionIdleDt = 0;
    sessionSuppressed = false;
    return;
  }
  if (input.throttle > 0) {
    if (!sessionSuppressed) {
      sessionOpen = true;
      sessionIdleDt = 0;
    }
    return;
  }
  // Off the throttle: re-arm, so a stopped take can be started again by
  // simply driving off.
  sessionSuppressed = false;
  if (!sessionOpen) return;
  // Coasting and braking keep the session alive; only a car that is both
  // stopped and off the throttle ages toward closing it.
  sessionIdleDt = V.speed === 0 ? sessionIdleDt + dt : 0;
  if (sessionIdleDt >= SESSION_IDLE_S) sessionOpen = false;
}

// Rendering -- the main view, the separate offscreen POV render, and its
// GPU->CPU pixel readback (a hard sync point) -- is by far the most
// expensive part of each tick, and pilotPredict is a real TF.js forward
// pass on top of that. None of it changes anything once the car is fully
// stopped and nothing (autopilot included) is driving it: same physics
// state in means the same pixels out. IDLE_SETTLE_S waits out the chase
// cam's follow-lerp actually converging (not just the car stopping)
// before skipping that work, so parking doesn't visibly snap the camera.
// Physics/HUD/telemetry keep running every tick regardless of idleness,
// so any input resumes full rendering on the very frame it matters.
const IDLE_SETTLE_S = 1.5;
let idleDt = 0;

// Forces rendering back on for the next IDLE_SETTLE_S. The idle skip above
// reasons purely about the CAR ("same physics state in means the same
// pixels out"), which silently assumes the car is the only thing that can
// change what's on screen. Anything that edits the scene while the car
// sits still breaks that assumption and has to say so here -- switching
// worlds replaces every mesh in the scene without moving the car one
// millimetre, so without this the new world isn't drawn until something
// happens to wake the loop (touching the throttle, or reloading the page).
function wakeRender() { idleDt = 0; }

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  fpsA += (1/Math.max(dt,1e-4) - fpsA) * 0.05;

  // The Gamepad API has no events for axis motion, so the pad is read
  // here, once per rendered frame. It sits before the autopilot override
  // below for the same reason the mouse does: while a model is driving,
  // nothing the human touches should reach the car.
  pollGamepads();

  // Animated world features (traffic light phases) run every frame,
  // independent of the render skip below -- a light has to keep cycling
  // while you sit at it, which is the whole point of sitting at it. It
  // reports back when a phase actually flips so the renderer can wake for
  // that frame without giving up the idle skip the rest of the time.
  if (stepWorld(dt)) wakeRender();

  // In autopilot the model's latest prediction overwrites input right
  // before physics, so stray mouse/key events between frames never steer
  // the car. (Deliberately total override for M2; M3's intervention mode
  // will let user input punch through and get recorded.)
  if (pilot.active) {
    input.steer = pilot.steer;
    input.throttle = pilot.throttle;
  } else if (recovery.active) {
    stepRecovery(dt);
    input.steer = recovery.steer;
    input.throttle = recovery.throttle;
  }

  acc += dt;
  while (acc >= DT) {
    prevX = V.x; prevZ = V.z; prevHeading = V.heading;
    step(DT);
    if (stepWorldFixed(DT, V)) wakeRender();
    acc -= DT;
  }

  // Recovery generation and reset paths intentionally teleport the car. Do
  // not interpolate from the old pose to the new one: that turns a jump cut
  // into a disorienting camera sweep. Reset the interpolation origin and
  // chase-camera follow target together.
  const poseJumped = poseVersion !== seenPoseVersion;
  if (poseJumped) {
    prevX = V.x; prevZ = V.z; prevHeading = V.heading;
    seenPoseVersion = poseVersion;
  }

  const rAlpha = acc / DT;
  placeCameras(prevX + (V.x - prevX) * rAlpha,
               prevZ + (V.z - prevZ) * rAlpha,
               prevHeading + (V.heading - prevHeading) * rAlpha,
               dt, poseJumped);

  // Proximity fading is based on the camera used for the displayed view,
  // not the forward POV/training camera. Update it only after chase-camera
  // damping has produced this frame's actual view position.
  if (stepWorld(0, chaseCam.position)) wakeRender();

  // Stationary means the car's own state stopped changing this tick;
  // autopilot and recovery generation always count as active regardless
  // of current speed, since both need a continuous, fresh camera feed to
  // keep perceiving (recovery episodes also start from V.speed === 0, at
  // the instant of a teleport).
  const stationary = V.speed === 0 && !pilot.active && !recovery.active;
  idleDt = stationary ? idleDt + dt : 0;
  const idle = idleDt > IDLE_SETTLE_S;

  // The 3D view/POV feed and the 20Hz predict/record tick only matter on
  // the driving screens (Drive, Eval, Recover) -- Data/Train are
  // full-screen, non-3D dashboards. Gating this is not just a CPU
  // optimization like the idle-skip above: scroll-wheel throttle holds
  // indefinitely once set (unlike keys), so without this gate, leaving
  // throttle nonzero and switching to Data/Train would silently keep
  // recording frames against a frozen, stale POV image (tubPush reads
  // whatever's currently in the #pov canvas) and keep burning a TF.js
  // forward pass every 50ms for nothing.
  const mode = getMode();
  const isDrivingScreen = mode === 'drive' || mode === 'eval' || mode === 'recover';

  // isGLAvailable: a context the browser takes away (backgrounding on iOS
  // is enough) comes back asynchronously, so frames can land while it is
  // still gone. three.js's render() sits those out on its own, but
  // readRenderTargetPixels below does not.
  if (isDrivingScreen && !idle && isGLAvailable()) {
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
  }

  // record at 20 Hz, independent of render rate, same fixed-step pattern
  // as physics. In Drive mode, for the whole of a DRIVING SESSION and
  // on-track (autopilot laps -- Eval -- are the model's own output;
  // feeding them back in as training data would just amplify its own
  // mistakes). In Recover mode, for the whole recovery episode, on-track
  // or not -- going off-track there is the deliberately-induced starting
  // pose, not a mistake to gate out (see recovery.js).
  updateSession(dt, mode);
  const isRecording = mode === 'drive'
    ? (sessionOpen && !offTrack)
    : (mode === 'recover' && recovery.active);
  recAcc += dt;
  if (recAcc >= REC_DT) {
    recAcc -= REC_DT;
    if (isDrivingScreen) {
      // Predict whenever a model is loaded, even in manual mode: that's the
      // "shadow drive" needle -- model opinion vs. your hands, live, even
      // while parked. Not gated on idle like the render above: povImage is
      // just stale rather than skipped, and a stale-but-unchanged frame
      // (nothing moved) is exactly what a fresh render would produce anyway.
      if (pilot.ready) pilotPredict(povImage);
      if (isRecording) tubPush(simTime, input.steer, input.throttle);
    }
  }

  drawHud();
  drawDataset(isRecording);
  // Drive only: isRecording is also true throughout a recovery-generation
  // episode, but stopSession() governs manual driving sessions and would
  // do nothing there -- a visible button that ignores clicks is worse than
  // no button. Recover mode has its own stop control in its panel.
  drawRecordButton(isRecording && mode === 'drive');
  syncDataAvailability();
  drawPilot();
  drawRecover();
  setFps(fpsA, idle);
}

// ---------- resize ----------
// Matches the drawing buffer + camera aspect to the canvas's ACTUAL
// displayed box, which #view's CSS (width/height:100%) pins to the
// viewport independently of anything here -- see the comment on that
// rule for why the CSS size is load-bearing.
//
// Reading the canvas's own box rather than innerWidth/innerHeight is
// what keeps the aspect ratio honest on iOS, where the layout and visual
// viewports diverge as the toolbar shows/hides: whatever the browser
// actually laid the canvas out as is exactly what we render for, so the
// image can never end up stretched or offset. (This read is only
// non-circular because CSS pins the size; deriving the size from the
// canvas while the canvas was sized by its own buffer attributes made it
// collapse to the 300x150 canvas default.)
//
// ResizeObserver rather than just window 'resize': it fires whenever the
// box actually changes for any reason -- orientation, iOS's dynamic
// toolbar, safe-area insets -- several of which don't reliably fire a
// window resize event. Nothing here writes to the canvas's CSS, so this
// cannot feed back into itself.
function resize() {
  const r = canvas.getBoundingClientRect();
  // Guard against a zero-size read (never expected while #view is
  // always laid out, but a 0 here would poison chaseCam.aspect with
  // NaN/Infinity and blank the view until the next resize).
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  renderer.setSize(w, h, false);
  chaseCam.aspect = w / h;
  chaseCam.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);
addEventListener('resize', resize);
resize();

// go
chaseCam.position.set(V.x - Math.sin(V.heading)*6.4, 3, V.z - Math.cos(V.heading)*6.4);
requestAnimationFrame(frame);
