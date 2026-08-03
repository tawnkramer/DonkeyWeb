import * as THREE from 'three';
import { boxCollider, circleCollider } from './collide.js';

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

const DEFAULT_BUILDINGS = {
  spacing: 26,      // samples between plots
  setback: 4.5,     // m from road edge to the building face
  density: 0.82,    // chance a given plot is built on
  seed: 5,
  minH: 7, maxH: 26,
  minAlong: 8, maxAlong: 16,   // frontage along the street
  minAcross: 7, maxAcross: 13, // depth into the block
  palette: [0x8a8479, 0x6f7a82, 0x9a8b7a, 0x7a6f6a, 0x88909a, 0x9c9384],
  roof: 0x4b4f55,
};

const DEFAULT_STREETLIGHTS = {
  spacing: 34, setback: 1.2, height: 5.4,
  pole: 0x3a3f45, lamp: 0xffe9b0,
};

export function buildScenery(spec, road) {
  const { SAMPLES, width, centers, tangents, normalAt } = road;
  const group = new THREE.Group();
  // Only consulted by worlds that reset on collision; built regardless so
  // a world can switch its reset rule without touching its scenery.
  const colliders = [];

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

  // Buildings follow the street at a fixed setback instead of being
  // scattered on a ring like the trees above -- a city reads as a city
  // because the frontages line up along the road, and scattering boxes
  // gives you a quarry with cubes in it. Flat-shaded bodies with a roof
  // cap, matching the low-poly language of the cones and trees rather
  // than reaching for window textures.
  if (spec.buildings) {
    const cfg = { ...DEFAULT_BUILDINGS, ...spec.buildings };
    const rng = mulberry(cfg.seed);
    const mats = cfg.palette.map(color => new THREE.MeshLambertMaterial({ color }));
    const roofMat = new THREE.MeshLambertMaterial({ color: cfg.roof });

    for (let i = 0; i < SAMPLES; i += cfg.spacing) {
      for (const side of [-1, 1]) {
        if (rng() > cfg.density) continue;
        const along  = cfg.minAlong  + rng() * (cfg.maxAlong  - cfg.minAlong);
        const across = cfg.minAcross + rng() * (cfg.maxAcross - cfg.minAcross);
        const h = cfg.minH + rng() * (cfg.maxH - cfg.minH);
        const n = normalAt(i);
        const off = width/2 + cfg.setback + across/2;
        const p = centers[i].clone().addScaledVector(n, side * off);
        // Yaw so local +Z runs along the road: `along` is frontage, and
        // `across` is depth away from the street.
        const yaw = Math.atan2(tangents[i].x, tangents[i].z);

        const body = new THREE.Mesh(
          new THREE.BoxGeometry(across, h, along),
          mats[Math.floor(rng() * mats.length)],
        );
        body.position.set(p.x, h/2, p.z);
        body.rotation.y = yaw;
        body.castShadow = true; body.receiveShadow = true;

        const cap = new THREE.Mesh(new THREE.BoxGeometry(across + 0.5, 0.5, along + 0.5), roofMat);
        cap.position.set(p.x, h + 0.25, p.z);
        cap.rotation.y = yaw;
        cap.castShadow = true;

        group.add(body, cap);
        // Half-extents in the box's own frame: across is its local X, the
        // frontage runs along local Z. Same yaw as the mesh.
        colliders.push(boxCollider(p.x, p.z, across / 2, along / 2, yaw));
      }
    }
  }

  if (spec.streetlights) {
    const cfg = { ...DEFAULT_STREETLIGHTS, ...spec.streetlights };
    const poleMat = new THREE.MeshLambertMaterial({ color: cfg.pole });
    // Basic, not Lambert: the lamp is meant to look like it's emitting,
    // and a Lambert lamp just goes the colour of whatever light hits it.
    const lampMat = new THREE.MeshBasicMaterial({ color: cfg.lamp });
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, cfg.height, 6);
    // Unit length on X so each post can scale it to its own reach.
    const armGeo = new THREE.BoxGeometry(1, 0.09, 0.09);
    const lampGeo = new THREE.BoxGeometry(0.5, 0.14, 0.26);

    let side = 1;
    for (let i = 0; i < SAMPLES; i += cfg.spacing) {
      const n = normalAt(i);
      const off = width/2 + cfg.setback;
      const p = centers[i].clone().addScaledVector(n, side * off);
      const yaw = Math.atan2(tangents[i].x, tangents[i].z);

      const post = new THREE.Group();
      post.position.set(p.x, 0, p.z);
      post.rotation.y = yaw;

      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.y = cfg.height / 2;
      pole.castShadow = true;
      // The arm reaches out over the middle of the near lane, which is
      // where a street lamp actually hangs -- a fixed short stub left it
      // sitting over the kerb doing nothing for the road. `reach` is
      // derived from the road so it stays right whatever width a world
      // uses: lane centre is a quarter of the road width off the middle.
      //
      // Local +X, not -X -- see the same note in sim/trafficlight.js:
      // rotation.y maps local +X to the NEGATIVE of normalAt(), and the
      // post stands at a positive normal offset, so -X reaches away from
      // the road rather than over it.
      const reach = off - width / 4;
      const arm = new THREE.Mesh(armGeo, poleMat);
      arm.scale.x = reach;
      arm.position.set(side * reach / 2, cfg.height, 0);
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(side * reach, cfg.height - 0.12, 0);
      post.add(pole, arm, lamp);
      group.add(post);
      colliders.push(circleCollider(p.x, p.z, 0.16));

      side *= -1;   // alternate kerbs down the street
    }
  }

  return { group, colliders };
}
