import * as THREE from 'three';
import {
  STOP_BAR_DEPTH, buildSignalParts, paintSignal,
  makeSignalFader,
} from './signalparts.js';
import { CROSSWALK_OUTER_M } from './roadgraph.js';

const PHASES = ['green', 'yellow', 'red'];
const STOP_TO_CROSSWALK_M = 1;

// Edge samples are not uniformly spaced at their Catmull-Rom endpoints; in
// particular the first interval can be effectively zero. Walk real distance
// from the node instead of converting metres with centers[0]->centers[1].
// The latter can clamp all the way to the opposite end of an edge, painting
// this junction's stop bar beside the next junction's outgoing lane.
function pointBackFromNode(edge, atFrom, metres) {
  let local = atFrom ? 0 : edge.SAMPLES - 1;
  let walked = 0;
  const step = atFrom ? 1 : -1;
  while (local + step >= 0 && local + step < edge.SAMPLES && walked < metres) {
    const next = local + step;
    const segment = edge.centers[local].distanceTo(edge.centers[next]);
    if (walked + segment >= metres && segment > 1e-9) {
      const t = (metres - walked) / segment;
      return {
        local: t < 0.5 ? local : next,
        point: edge.centers[local].clone().lerp(edge.centers[next], t),
      };
    }
    walked += segment;
    local += step;
  }
  return { local, point: edge.centers[local].clone() };
}

// Signals are attached to graph nodes rather than global flattened samples.
// Each incident edge contributes one approach. Its mast sits beyond the far
// kerb, with the arm reaching back over the incoming lane, so the head stays
// visible while the driver approaches and waits at the near-side stop bar.
// Each node owns one coordinated clock: north/south traffic shares a phase,
// east/west traffic shares the other, with yellow and all-red clearance
// between green windows. Nothing enforces a red light; it is visual training
// guidance, matching the loop traffic-light feature.
export function buildIntersectionSignals(spec, road) {
  if (!road.graph) throw new Error('intersection signals require a road graph');
  const cycle = { green: 9, yellow: 2.5, allRed: 1, ...(spec.cycle || {}) };
  const halfCycle = cycle.green + cycle.yellow + cycle.allRed;
  const period = halfCycle * 2;
  const requested = spec.nodes || spec.node ? (spec.nodes || [spec.node]) : null;
  const degree = new Map(road.graph.nodes.map(n => [n.id, 0]));
  for (const edge of road.graph.edges) {
    degree.set(edge.from, degree.get(edge.from) + 1);
    degree.set(edge.to, degree.get(edge.to) + 1);
  }
  const nodes = road.graph.nodes.filter(n => {
    if (requested) return requested.includes(n.id);
    return spec.allIntersections ? degree.get(n.id) >= 3 : n.type === 'signal';
  });
  const group = new THREE.Group();
  const colliders = [];
  const signals = [];

  for (const node of nodes) {
    const incident = road.graph.edges.filter(e => e.from === node.id || e.to === node.id);
    for (const edge of incident) {
      const atFrom = edge.from === node.id;
      const near = atFrom ? 0 : edge.SAMPLES - 1;
      const travel = atFrom ? edge.tangents[0].clone().negate() : edge.tangents[near].clone();
      const normal = new THREE.Vector3(-travel.z, 0, travel.x);
      // Crosswalk starts at the pad and extends CROSSWALK_OUTER_M outward.
      // Add the requested clear gap plus half the bar depth because this is
      // the bar centre, not its crosswalk-facing edge.
      const stopBack = CROSSWALK_OUTER_M + STOP_TO_CROSSWALK_M + STOP_BAR_DEPTH / 2;
      const { local: stopLocal, point: stopCenter } = pointBackFromNode(edge, atFrom, stopBack);
      // The road edge ends at the near pad boundary. Put the mast just past
      // the opposite boundary, along the incoming travel direction. In the
      // road builder's lateral convention side +1 is the US right-hand lane;
      // the arm then reaches inward while leaving the head over that lane.
      const center = new THREE.Vector3(node.pos[0], 0, node.pos[1])
        .addScaledVector(travel, node.pad / 2 + 0.5);
      const built = buildSignalParts({
        center, tangent: travel, normal, width: edge.width, stopCenter, side: 1,
      });
      group.add(built.group);
      colliders.push(built.collider);
      signals.push({
        node: node.id,
        edge: edge.id,
        stopIdx: edge.globalOffset + stopLocal,
        axis: Math.abs(travel.x) > Math.abs(travel.z) ? 'EW' : 'NS',
        // Distance from the junction centre back along this approach to the
        // painted stop-bar centre. Traffic consumes this instead of guessing
        // from the pad/crosswalk constants, so geometry and enforcement cannot
        // drift apart.
        stopDistance: stopCenter.distanceTo(new THREE.Vector3(node.pos[0], 0, node.pos[1])),
        mats: built.lampMats,
        fade: makeSignalFader(built.light),
        phase: null,
      });
    }
  }

  function activePhase(t) {
    if (t < cycle.green) return 'green';
    if (t < cycle.green + cycle.yellow) return 'yellow';
    return 'red';
  }

  let time = 0;
  function step(dt, camera) {
    time = (time + dt) % period;
    let changed = false;
    for (const signal of signals) {
      if (signal.fade(camera)) changed = true;
      const window = signal.axis === 'NS' ? time : (time + halfCycle) % period;
      const next = window < halfCycle ? activePhase(window) : 'red';
      if (next === signal.phase) continue;
      signal.phase = next;
      paintSignal(signal.mats, next);
      changed = true;
    }
    return changed;
  }
  step(0);

  return {
    group,
    colliders,
    step,
    states: () => signals.map(({ node, edge, stopIdx, stopDistance, axis, phase }) =>
      ({ node, edge, stopIdx, stopDistance, axis, phase })),
  };
}
