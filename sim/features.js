import * as THREE from 'three';
import { buildTrafficLights } from './trafficlight.js';

// ---------- world features ----------
// The `features: []` list in a world spec, turned into scene objects plus
// an optional per-frame update. Dispatch table rather than a chain of ifs
// so adding a feature type is one entry here plus its own builder module.
//
// A builder returns { group, step?, states? }. `step(dt)` must report
// whether anything visually changed -- see sim/main.js's idle rendering
// skip, which stays off unless something says otherwise.
const BUILDERS = {
  trafficLights: buildTrafficLights,
};

export function buildFeatures(specs, road) {
  const group = new THREE.Group();
  const steps = [];
  const byType = new Map();
  const colliders = [];

  for (const spec of specs) {
    const build = BUILDERS[spec.type];
    if (!build) throw new Error(`unknown world feature type: ${spec.type}`);
    const built = build(spec, road);
    group.add(built.group);
    if (built.step) steps.push(built.step);
    if (built.states) byType.set(spec.type, built.states);
    if (built.colliders) colliders.push(...built.colliders);
  }

  return {
    group,
    colliders,
    step(dt) {
      // Not `some()`: every feature must be stepped, and some() stops at
      // the first truthy result.
      let changed = false;
      for (const s of steps) if (s(dt)) changed = true;
      return changed;
    },
    states(type) {
      const fn = byType.get(type);
      return fn ? fn() : [];
    },
  };
}
