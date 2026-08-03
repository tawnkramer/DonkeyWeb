import * as THREE from 'three';
import { scene, applyEnvironment } from './scene.js';
import { buildRoad } from './road.js';
import { buildScenery } from './scenery.js';
import { WORLDS, DEFAULT_WORLD_ID, findWorld } from '../worlds/index.js';

// ---------- the active world ----------
// Owns which world is live: builds its road + scenery, adds them to the
// scene, and tears the previous one down. sim/road.js and sim/scenery.js
// are pure builders; this module is the only thing that mutates the scene
// graph for a world.
//
// `road` is a single object mutated IN PLACE rather than a set of exported
// consts, which is what makes swapping possible at all: car.js and
// recovery.js import this object once and keep reading through it, so they
// see the new road the instant it changes. (Exported consts -- what
// track.js used to do -- bake the first world in permanently.)
export const road = {
  SAMPLES: 0,
  width: 0,
  startIdx: 0,
  centers: [],
  tangents: [],
  // Defined here, not taken from the builder, so it always reads the live
  // tangents instead of closing over one particular world's array.
  normalAt: i => new THREE.Vector3(-road.tangents[i].z, 0, road.tangents[i].x),
};

const STORE_KEY = 'donkeyweb-world';

let current = null;        // the active spec
let roadGroup = null;      // live scene objects, kept for teardown
let sceneryGroup = null;

// Same push-subscription shape as mode.js's onModeChange: world.js can't
// import car.js to reset the vehicle (car.js imports this module, so that
// would be a cycle), so whoever wires the sim decides what a world change
// does to the car. See main.js.
const listeners = new Set();
export function onWorldChange(fn) { listeners.add(fn); }

export function listWorlds() {
  return WORLDS.map(w => ({ id: w.id, name: w.name, blurb: w.blurb }));
}

export function getWorld() { return current; }
export function getWorldId() { return current ? current.id : null; }

function disposeGroup(group) {
  group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) m.dispose();
    }
  });
  scene.remove(group);
}

function activate(spec) {
  const built = buildRoad(spec);
  const scenery = buildScenery(spec.scenery || {}, built);

  // Build first, tear down second: if a world module is malformed, the
  // throw happens before the current world is removed, so a bad spec
  // leaves the sim on the road it already had instead of on nothing.
  if (roadGroup) disposeGroup(roadGroup);
  if (sceneryGroup) disposeGroup(sceneryGroup);
  roadGroup = built.group;
  sceneryGroup = scenery;
  scene.add(roadGroup, sceneryGroup);

  applyEnvironment(spec.env);

  road.SAMPLES = built.SAMPLES;
  road.width = built.width;
  road.startIdx = built.startIdx;
  road.centers = built.centers;
  road.tangents = built.tangents;

  current = spec;
}

export function setWorld(id) {
  const spec = findWorld(id);
  if (!spec || spec === current) return false;
  activate(spec);
  try { localStorage.setItem(STORE_KEY, spec.id); } catch { /* private mode */ }
  for (const fn of listeners) fn(spec);
  return true;
}

// Initial world, at import time -- car.js reads road.centers/startIdx while
// initializing its own pose, so a road has to exist before that runs.
{
  let startId = DEFAULT_WORLD_ID;
  try { startId = localStorage.getItem(STORE_KEY) || DEFAULT_WORLD_ID; } catch { /* private mode */ }
  activate(findWorld(startId) || findWorld(DEFAULT_WORLD_ID));
}
