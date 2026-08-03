import * as THREE from 'three';

// ---------- scenery builder ----------
// Cones on tight corners, low-poly trees off the road. Pure like
// sim/road.js: builds a group and returns it, so sim/world.js can dispose
// the whole thing on a world switch.

function mulberry(seed){return function(){let t=seed+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}

const DEFAULT_CONES = { color: 0xff6a2b, turn: 0.075, offset: 0.7 };
const DEFAULT_TREES = {
  count: 90, seed: 7, trunk: 0x7a5a44, leaf: 0x5d8a5f,
  ringMin: 24, ringSpan: 180, clearance: 14,
  trunkH: 1.4, leafR: 1.5, leafH: 3.4,
};

export function buildScenery(spec, road) {
  const { SAMPLES, width, centers, tangents, normalAt } = road;
  const group = new THREE.Group();

  if (spec.cones !== false) {
    const cfg = { ...DEFAULT_CONES, ...(spec.cones || {}) };
    const coneMat = new THREE.MeshLambertMaterial({color: cfg.color});
    const coneGeo = new THREE.ConeGeometry(0.28, 0.62, 8);
    for (let i = 0; i < SAMPLES; i += 6) {
      const iN = (i+6) % SAMPLES;
      const turn = tangents[i].angleTo(tangents[iN]);
      if (turn > cfg.turn) { // curvature threshold → outside of corner gets cones
        const n = normalAt(i);
        const side = Math.sign(tangents[i].clone().cross(tangents[iN]).y) || 1;
        const p = centers[i].clone().addScaledVector(n, -side * (width/2 + cfg.offset));
        const cone = new THREE.Mesh(coneGeo, coneMat);
        cone.position.set(p.x, 0.31, p.z);
        cone.castShadow = true;
        group.add(cone);
      }
    }
  }

  if (spec.trees !== false) {
    const cfg = { ...DEFAULT_TREES, ...(spec.trees || {}) };
    const trunkG = new THREE.CylinderGeometry(0.22, 0.3, cfg.trunkH, 6);
    const leafG  = new THREE.ConeGeometry(cfg.leafR, cfg.leafH, 7);
    const trunkM = new THREE.MeshLambertMaterial({color: cfg.trunk});
    const leafM  = new THREE.MeshLambertMaterial({color: cfg.leaf});
    const rng = mulberry(cfg.seed);
    const clear2 = cfg.clearance * cfg.clearance;
    let placed = 0, guard = 0;
    while (placed < cfg.count && guard++ < cfg.count * 9) {
      const a = rng()*Math.PI*2, r = cfg.ringMin + rng()*cfg.ringSpan;
      const x = Math.cos(a)*r, z = Math.sin(a)*r;
      // keep clear of the road
      let ok = true;
      for (let i = 0; i < SAMPLES; i += 10) {
        const dx = centers[i].x - x, dz = centers[i].z - z;
        if (dx*dx + dz*dz < clear2) { ok = false; break; }
      }
      if (!ok) continue;
      const s = 0.7 + rng()*0.9;
      const tr = new THREE.Mesh(trunkG, trunkM);
      tr.position.set(x, 0.5*cfg.trunkH*s, z); tr.scale.setScalar(s); tr.castShadow = true;
      const lf = new THREE.Mesh(leafG, leafM);
      lf.position.set(x, (cfg.trunkH + cfg.leafR)*s, z); lf.scale.setScalar(s); lf.castShadow = true;
      group.add(tr, lf);
      placed++;
    }
  }

  return group;
}
