import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildRoadGraph, CROSSWALK_OUTER_M } from '../sim/roadgraph.js';
import { buildIntersectionSignals } from '../sim/intersectionSignals.js';
import { STOP_BAR_DEPTH } from '../sim/signalparts.js';
import streetGrid from '../worlds/street-grid.js';

const featureSpec = streetGrid.features.find(f => f.type === 'intersectionSignals');

function fixture() {
  const road = buildRoadGraph(streetGrid);
  return { road, built: buildIntersectionSignals(featureSpec, road) };
}

test('every junction approach has a far-side signal over its incoming lane', () => {
  const { road, built } = fixture();
  const states = built.states();
  assert.equal(states.length, 40, 'four 4-ways and eight Ts should provide 40 approaches');
  assert.equal(built.group.children.length, states.length);
  built.group.updateMatrixWorld(true);

  states.forEach((state, i) => {
    const node = road.graph.nodes.find(n => n.id === state.node);
    const edge = road.graph.edges.find(e => e.id === state.edge);
    const atFrom = edge.from === node.id;
    const near = atFrom ? 0 : edge.SAMPLES - 1;
    const travel = atFrom
      ? edge.tangents[0].clone().negate()
      : edge.tangents[near].clone();
    // Match the road builder's signed lateral convention used by the car
    // and scenery placement: positive normal is the US right-hand lane.
    const right = new THREE.Vector3(-travel.z, 0, travel.x);
    const origin = new THREE.Vector3(node.pos[0], 0, node.pos[1]);

    const assembly = built.group.children[i];
    const light = assembly.children[0];
    const mast = new THREE.Vector3();
    light.getWorldPosition(mast);
    const mastFromNode = mast.clone().sub(origin);
    assert.ok(mastFromNode.dot(travel) > node.pad / 2,
      `${node.id}/${edge.id} mast is not beyond the far kerb`);

    const head = light.children.find(o => o.type === 'Group');
    const headPos = new THREE.Vector3();
    head.getWorldPosition(headPos);
    const headFromNode = headPos.clone().sub(origin);
    assert.ok(headFromNode.dot(right) > 0,
      `${node.id}/${edge.id} head does not overhang the incoming lane`);

    const bar = assembly.children[1];
    const barPos = new THREE.Vector3();
    bar.getWorldPosition(barPos);
    const nearCenter = edge.centers[state.stopIdx - edge.globalOffset];
    assert.ok(barPos.clone().sub(nearCenter).dot(right) > 0,
      `${node.id}/${edge.id} stop bar is not confined to the incoming lane`);
    assert.ok(bar.geometry.parameters.width < edge.width / 2,
      `${node.id}/${edge.id} stop bar spans the uncontrolled outgoing lane`);
    // The zebra crossing begins immediately outside the near pad boundary.
    // In approach order the lane-width stop bar must therefore be farther
    // from the node than that boundary: bar, crosswalk, intersection.
    const barAlong = barPos.clone().sub(origin).dot(travel);
    assert.ok(barAlong < -node.pad / 2,
      `${node.id}/${edge.id} stop bar is after the crosswalk`);
    const backFromKerb = -barAlong - node.pad / 2;
    const clearGap = backFromKerb - CROSSWALK_OUTER_M - STOP_BAR_DEPTH / 2;
    assert.ok(Math.abs(clearGap - 1) < 0.05,
      `${node.id}/${edge.id} stop bar is ${clearGap.toFixed(2)}m from the crosswalk`);
  });
});

test('junction phases coordinate parallel approaches without crossing greens', () => {
  const { built } = fixture();
  const assertSafe = label => {
    const byNode = new Map();
    for (const signal of built.states()) {
      if (!byNode.has(signal.node)) byNode.set(signal.node, []);
      byNode.get(signal.node).push(signal);
    }
    assert.equal(byNode.size, 12);
    for (const [node, signals] of byNode) {
      for (const axis of ['NS', 'EW']) {
        const phases = new Set(signals.filter(s => s.axis === axis).map(s => s.phase));
        assert.ok(phases.size <= 1, `${label}: ${node} ${axis} is not coordinated`);
      }
      const greenAxes = new Set(signals.filter(s => s.phase === 'green').map(s => s.axis));
      assert.ok(greenAxes.size <= 1, `${label}: ${node} gives green to crossing traffic`);
    }
  };

  assertSafe('NS green');
  built.step(9.1);
  assertSafe('NS yellow');
  built.step(3.5);
  assertSafe('EW green');
  built.step(9.1);
  assertSafe('EW yellow');
});
