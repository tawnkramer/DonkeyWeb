import * as THREE from 'three';
import { scene } from './scene.js';
import { SAMPLES, TRACK_W, centers, tangents, normalAt } from './track.js';

// ---------- scenery: cones on tight corners, low-poly trees ----------
const coneMat = new THREE.MeshLambertMaterial({color:0xff6a2b});
const coneGeo = new THREE.ConeGeometry(0.28, 0.62, 8);
for (let i = 0; i < SAMPLES; i += 6) {
  const iN = (i+6) % SAMPLES;
  const turn = tangents[i].angleTo(tangents[iN]);
  if (turn > 0.075) { // curvature threshold → outside of corner gets cones
    const n = normalAt(i);
    const side = Math.sign(tangents[i].clone().cross(tangents[iN]).y) || 1;
    const p = centers[i].clone().addScaledVector(n, -side * (TRACK_W/2 + 0.7));
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.set(p.x, 0.31, p.z);
    cone.castShadow = true;
    scene.add(cone);
  }
}

function mulberry(seed){return function(){let t=seed+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}

{
  const trunkG = new THREE.CylinderGeometry(0.22, 0.3, 1.4, 6);
  const leafG  = new THREE.ConeGeometry(1.5, 3.4, 7);
  const trunkM = new THREE.MeshLambertMaterial({color:0x7a5a44});
  const leafM  = new THREE.MeshLambertMaterial({color:0x5d8a5f});
  const rng = mulberry(7);
  let placed = 0, guard = 0;
  while (placed < 90 && guard++ < 800) {
    const a = rng()*Math.PI*2, r = 24 + rng()*180;
    const x = Math.cos(a)*r, z = Math.sin(a)*r;
    // keep clear of the road
    let ok = true;
    for (let i = 0; i < SAMPLES; i += 10) {
      const dx = centers[i].x - x, dz = centers[i].z - z;
      if (dx*dx + dz*dz < 14*14) { ok = false; break; }
    }
    if (!ok) continue;
    const s = 0.7 + rng()*0.9;
    const tr = new THREE.Mesh(trunkG, trunkM);
    tr.position.set(x, 0.7*s, z); tr.scale.setScalar(s); tr.castShadow = true;
    const lf = new THREE.Mesh(leafG, leafM);
    lf.position.set(x, (1.4 + 1.5)*s, z); lf.scale.setScalar(s); lf.castShadow = true;
    scene.add(tr, lf);
    placed++;
  }
}
