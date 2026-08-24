import * as THREE from 'three';
import { scene, applyEnvironment } from './scene.js';
import { buildRoad } from './road.js';
import { buildRoadGraph } from './roadgraph.js';
import { buildScenery } from './scenery.js';
import { buildFeatures } from './features.js';
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
  // { nodes, edges } on a graph world (see sim/roadgraph.js), undefined on a
  // loop world. car.js reads its mere presence to tell the two apart --
  // notably, to know when road.centers is a flattened concatenation of
  // unrelated edges rather than one continuous path.
  graph: undefined,
  // Whether car.js's off-track "grass drag" deceleration applies. True for
  // every loop world, where straying from road.centers really does mean you
  // left the intended line. Graph worlds set this false: there, the
  // flattened centerline is a bookkeeping artifact (see roadgraph.js), and
  // turning onto a cross-street or crossing an intersection pad would
  // otherwise read as a large, bogus cross-track error and brake the car for
  // doing exactly what the street layout invites.
  dragOnOffTrack: true,
};

// How the active world decides the driver has failed, and what's solid.
// 'offTrack' is the original rule: stray more than half a road-width from
// the centreline and you're put back on the line. That rule doesn't
// survive a city -- there the roadway is somewhere to move around in, and
// the thing that should end a run is hitting a building, not being off
// the middle of the road. See car.js for the rewind that follows.
export const collision = { enabled: false, list: [] };

const STORE_KEY = 'donkeyweb-world';

let current = null;        // the active spec
let roadGroup = null;      // live scene objects, kept for teardown
let sceneryGroup = null;
let featureGroup = null;
let features = null;       // { step, states } for the active world

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

// Advances the active world's animated features. Returns whether anything
// visually changed, which main.js uses to break its idle rendering skip --
// a traffic light holds one colour for seconds at a time, so waking on the
// phase flip alone keeps the idle optimization intact instead of forcing a
// permanent full-rate render on any world that has a light in it.
export function stepWorld(dt) {
  return features ? features.step(dt) : false;
}

// Live state of a feature type, for the HUD and for tests.
export function featureStates(type) {
  return features ? features.states(type) : [];
}

function disposeGroup(group) {
  group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        // Textures are not freed by material.dispose() -- they're separate
        // GPU allocations and have to be released by hand.
        for (const key of ['map', 'alphaMap', 'emissiveMap', 'normalMap']) {
          if (m[key]) m[key].dispose();
        }
        m.dispose();
      }
    }
  });
  scene.remove(group);
}

function activate(spec) {
  const built = spec.graph ? buildRoadGraph(spec) : buildRoad(spec);
  const scenery = buildScenery(spec.scenery || {}, built);
  const feats = buildFeatures(spec.features || [], built);

  // Build first, tear down second: if a world module is malformed, the
  // throw happens before the current world is removed, so a bad spec
  // leaves the sim on the road it already had instead of on nothing.
  if (roadGroup) disposeGroup(roadGroup);
  if (sceneryGroup) disposeGroup(sceneryGroup);
  if (featureGroup) disposeGroup(featureGroup);
  roadGroup = built.group;
  sceneryGroup = scenery.group;
  featureGroup = feats.group;
  features = feats;
  scene.add(roadGroup, sceneryGroup, featureGroup);

  collision.enabled = spec.reset === 'collision';
  collision.list = [...scenery.colliders, ...feats.colliders];

  applyEnvironment(spec.env);

  road.SAMPLES = built.SAMPLES;
  road.width = built.width;
  road.startIdx = built.startIdx;
  road.centers = built.centers;
  road.tangents = built.tangents;
  road.graph = built.graph;
  road.dragOnOffTrack = spec.dragOnOffTrack ?? true;

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
