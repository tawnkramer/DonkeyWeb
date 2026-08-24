import * as THREE from 'three';
import { circleCollider } from './collide.js';

// Keep these dimensions shared by loop and intersection signals. They are
// intentionally sized for the 160x120 training frame; realistic heads are
// too small to teach from and realistic mounting heights leave the frame as
// the car reaches the stop line.
export const RED = 0xff3b30;
export const YELLOW = 0xffc400;
export const GREEN = 0x34d158;
export const DARK = 0x241f1c;
export const POLE_H = 4.2;
export const HEAD_Y = 3.2;
export const LAMP_R = 0.26;
export const LAMP_GAP = 0.72;
export const STOP_BACK_M = 8;
export const STOP_BAR_DEPTH = 0.6;

// Build one signal mast and its stop bar. `tangent` is the direction of the
// approaching car; `normal` is the road normal for that direction. The
// returned lamp materials are private to this assembly because each signal
// changes independently.
export function buildSignalParts({ center, tangent, normal, width, stopCenter, side = 1 }) {
  const group = new THREE.Group();
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x30343a });
  const housingMat = new THREE.MeshLambertMaterial({ color: 0x1b1e22 });
  const poleGeo = new THREE.CylinderGeometry(0.11, 0.13, POLE_H, 8);
  const armGeo = new THREE.BoxGeometry(0.1, 0.1, 1);
  const housingGeo = new THREE.BoxGeometry(0.8, LAMP_GAP * 3 + 0.2, 0.5);
  const lampGeo = new THREE.SphereGeometry(LAMP_R, 12, 10);
  const lampMats = [
    new THREE.MeshBasicMaterial({ color: DARK }),
    new THREE.MeshBasicMaterial({ color: DARK }),
    new THREE.MeshBasicMaterial({ color: DARK }),
  ];

  const heading = Math.atan2(tangent.x, tangent.z);
  const baseOff = width / 2 + 0.9;
  const light = new THREE.Group();
  light.position.set(center.x + normal.x * side * baseOff, 0,
    center.z + normal.z * side * baseOff);
  light.rotation.y = heading;

  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = POLE_H / 2;
  pole.castShadow = true;
  light.add(pole);

  const armLen = width * 0.42;
  const arm = new THREE.Mesh(armGeo, poleMat);
  arm.scale.z = armLen;
  arm.rotation.y = Math.PI / 2;
  arm.position.set(armLen / 2 * side, POLE_H - 0.3, 0);
  light.add(arm);

  const head = new THREE.Group();
  head.position.set(armLen * side, HEAD_Y, 0);
  head.rotation.y = Math.PI;
  const housing = new THREE.Mesh(housingGeo, housingMat);
  housing.castShadow = true;
  head.add(housing);
  lampMats.forEach((material, j) => {
    const lamp = new THREE.Mesh(lampGeo, material);
    lamp.position.set(0, LAMP_GAP - j * LAMP_GAP, 0.28);
    head.add(lamp);
  });
  light.add(head);
  group.add(light);

  const flatAlong = new THREE.Quaternion()
    .setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent)
    .multiply(new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), -Math.PI / 2));
  const bar = new THREE.Mesh(
    // A stop bar belongs only to the controlled incoming lane. Spanning the
    // whole road paints the outgoing half even though no signal faces it.
    new THREE.PlaneGeometry(width * 0.46, STOP_BAR_DEPTH),
    new THREE.MeshBasicMaterial({ color: 0xf2f0ea }),
  );
  bar.position.set(
    stopCenter.x + normal.x * side * width / 4,
    0.05,
    stopCenter.z + normal.z * side * width / 4,
  );
  bar.quaternion.copy(flatAlong);
  group.add(bar);

  return {
    group,
    lampMats,
    collider: circleCollider(light.position.x, light.position.z, 0.18),
  };
}

export function paintSignal(lampMats, phase) {
  lampMats[0].color.setHex(phase === 'red' ? RED : DARK);
  lampMats[1].color.setHex(phase === 'yellow' ? YELLOW : DARK);
  lampMats[2].color.setHex(phase === 'green' ? GREEN : DARK);
}
