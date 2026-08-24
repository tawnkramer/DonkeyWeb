import * as THREE from 'three';
import { circleCollider } from './collide.js';
import {
  RED, YELLOW, GREEN, DARK, POLE_H, HEAD_Y, LAMP_R, LAMP_GAP, STOP_BACK_M,
  makeSignalFader,
} from './signalparts.js';

// ---------- traffic lights ----------
// Lights sit ON the loop rather than at junctions, which is deliberate:
// there is no junction to sit at yet (the road is a single closed spline),
// and a light on a through-road is the one city behaviour this model can
// actually learn. The signal's state is visible in the pixels, so
// red -> throttle 0 and green -> throttle up is a function of the current
// frame. A stop SIGN is not: the frame at the line looks identical whether
// you just arrived or have been stopped for two seconds and are about to
// pull away, and a memoryless single-frame model cannot separate those.
//
// Nothing here enforces anything. Running a red is possible and is simply
// bad training data -- the human driver stopping is what teaches the
// model, exactly like staying on the road is.

const PHASES = ['green', 'yellow', 'red'];

// Signal head geometry, deliberately over-scale and mounted low. Two
// constraints drive this, and both come from the 160x120 POV frame rather
// than from realism:
//
// 1. A correctly-sized signal head is a couple of pixels across at that
//    resolution -- there is no lamp colour for the model to learn from.
// 2. At a realistic 5m mount height the head leaves the top of the frame
//    as you pull up to the line, so a car stopped at red and a car
//    stopped at green would see identical pixels. That is the same
//    unlearnable ambiguity that rules out stop signs here, and it would
//    quietly reintroduce it through the feature that was supposed to
//    avoid it.
//
// No mounting height fixes this on its own -- an overhead signal always
// climbs out of the top of the frame eventually as you close on it, and
// measured POV frames confirmed it: clearly readable at 10m, gone by 5m.
// So the signal comes with a painted stop bar STOP_BACK_M before it. That
// gives the driver a defined place to stop that is still far enough back
// for the head to sit inside the frame, which is what keeps "stopped at
// red" and "stopped at green" distinguishable in the training data.
//
// Checked against the POV camera (1.05m, pitched down 0.20rad, 80deg
// vertical FOV): from the bar, the head sits ~28deg off the camera axis
// against a 40deg half-FOV.
export function buildTrafficLights(spec, road) {
  const { centers, tangents, normalAt, width } = road;
  const cycle = { green: 9, yellow: 2.5, red: 7, ...(spec.cycle || {}) };
  const at = spec.at || [];
  const phaseOffsets = spec.phase || [];
  const period = cycle.green + cycle.yellow + cycle.red;

  const group = new THREE.Group();
  const poleGeo = new THREE.CylinderGeometry(0.11, 0.13, POLE_H, 8);
  const armGeo = new THREE.BoxGeometry(0.1, 0.1, 1);      // scaled per light
  const housingGeo = new THREE.BoxGeometry(0.8, LAMP_GAP * 3 + 0.2, 0.5);
  const lampGeo = new THREE.SphereGeometry(LAMP_R, 12, 10);
  const barGeo = new THREE.PlaneGeometry(width * 0.98, 0.6);
  const barMat = new THREE.MeshBasicMaterial({ color: 0xf2f0ea });

  // Lay-flat-then-aim-along-the-tangent transform, same as the road's
  // dashes and checker strip -- see sim/road.js for why this is a
  // quaternion and not a pair of Euler angles.
  const flatAlong = (t) => new THREE.Quaternion()
    .setFromUnitVectors(new THREE.Vector3(0, 0, 1), t)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI/2));

  const lights = [];
  const colliders = [];

  at.forEach((idx, k) => {
    // Private per assembly because camera-proximity fading changes opacity.
    // Sharing these would make approaching one signal fade every signal.
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x30343a });
    const housingMat = new THREE.MeshLambertMaterial({ color: 0x1b1e22 });
    const i = ((idx % centers.length) + centers.length) % centers.length;
    const c = centers[i], t = tangents[i], n = normalAt(i);
    // Right-hand side of the road, arm reaching back over the lane the car
    // is driving in, so the head is where a driver actually looks.
    const side = 1;
    const baseOff = width / 2 + 0.9;
    const heading = Math.atan2(t.x, t.z);

    const light = new THREE.Group();
    light.position.set(c.x + n.x * side * baseOff, 0, c.z + n.z * side * baseOff);
    light.rotation.y = heading;

    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = POLE_H / 2;
    pole.castShadow = true;
    light.add(pole);

    // Arm runs inward across the road. That is local +X, not -X: with
    // rotation.y = heading, three.js maps local +X to (cos h, 0, -sin h),
    // which is the NEGATIVE of normalAt() -- and the pole sits at a
    // positive normal offset. Getting this backwards swings the head out
    // over the pavement instead of the road, which puts it outside the
    // POV camera's horizontal FOV and hides the signal from the model.
    const armLen = width * 0.42;
    const arm = new THREE.Mesh(armGeo, poleMat);
    arm.scale.z = armLen;
    arm.rotation.y = Math.PI / 2;
    arm.position.set(armLen / 2 * side, POLE_H - 0.3, 0);
    light.add(arm);

    const head = new THREE.Group();
    head.position.set(armLen * side, HEAD_Y, 0);
    // The head faces back down the road at oncoming traffic.
    head.rotation.y = Math.PI;
    const housing = new THREE.Mesh(housingGeo, housingMat);
    housing.castShadow = true;
    head.add(housing);

    // Own material per lamp: these get recoloured on every phase change,
    // so they cannot be shared between lights (which run out of phase).
    const lampMats = [
      new THREE.MeshBasicMaterial({ color: DARK }),
      new THREE.MeshBasicMaterial({ color: DARK }),
      new THREE.MeshBasicMaterial({ color: DARK }),
    ];
    lampMats.forEach((m, j) => {
      const lamp = new THREE.Mesh(lampGeo, m);
      lamp.position.set(0, LAMP_GAP - j * LAMP_GAP, 0.28);
      head.add(lamp);
    });
    light.add(head);
    group.add(light);
    // Only the mast is solid. The head hangs 3.2m up, well over the car.
    colliders.push(circleCollider(light.position.x, light.position.z, 0.18));

    // Stop bar, measured in metres back along the road rather than a fixed
    // sample count -- sample spacing depends on the world's loop length.
    const spacing = c.distanceTo(centers[(i + 1) % centers.length]);
    const back = Math.round(STOP_BACK_M / Math.max(spacing, 1e-6));
    const s = ((i - back) % centers.length + centers.length) % centers.length;
    const bar = new THREE.Mesh(barGeo, barMat);
    bar.position.set(centers[s].x, 0.05, centers[s].z);
    bar.quaternion.copy(flatAlong(tangents[s]));
    group.add(bar);

    lights.push({
      idx: i,
      stopIdx: s,
      mats: lampMats,
      t: ((phaseOffsets[k] ?? 0) % period + period) % period,
      phase: null,
      fade: makeSignalFader(light),
    });
  });

  function phaseAt(t) {
    if (t < cycle.green) return 'green';
    if (t < cycle.green + cycle.yellow) return 'yellow';
    return 'red';
  }

  function paint(light) {
    const on = light.phase;
    light.mats[0].color.setHex(on === 'red' ? RED : DARK);
    light.mats[1].color.setHex(on === 'yellow' ? YELLOW : DARK);
    light.mats[2].color.setHex(on === 'green' ? GREEN : DARK);
  }

  // Returns whether anything visually changed, so main.js only has to wake
  // the renderer on an actual phase flip rather than every frame -- lights
  // are static for seconds at a time and the idle skip is worth keeping.
  function step(dt, camera) {
    let changed = false;
    for (const light of lights) {
      if (light.fade(camera)) changed = true;
      light.t = (light.t + dt) % period;
      const next = phaseAt(light.t);
      if (next !== light.phase) {
        light.phase = next;
        paint(light);
        changed = true;
      }
    }
    return changed;
  }

  // Paint the initial phase immediately: without this the first frame
  // renders every lamp dark until the first step() lands.
  step(0);

  return {
    group,
    colliders,
    step,
    states: () => lights.map(l => ({ idx: l.idx, stopIdx: l.stopIdx, phase: l.phase })),
  };
}

export { PHASES };
