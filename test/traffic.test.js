import { test } from 'node:test';
import assert from 'node:assert/strict';
import streetGrid from '../worlds/street-grid.js';
import { buildRoadGraph } from '../sim/roadgraph.js';
import { buildTraffic, resolveTrafficRoute } from '../sim/traffic.js';

test('traffic routes resolve into closed continuous paths through node pads', () => {
  const road = buildRoadGraph(streetGrid);
  const ids = ['A', 'C', 'D', 'B'];
  const path = resolveTrafficRoute(ids, road);
  assert.ok(path.length > 100);
  assert.equal(path.crossings.length, ids.length);
  for (let i = 1; i < path.points.length; i++) {
    assert.ok(path.points[i - 1].distanceTo(path.points[i]) < 7,
      `route jumped ${path.points[i - 1].distanceTo(path.points[i]).toFixed(1)}m at ${i}`);
  }
  assert.ok(path.points.at(-1).distanceTo(path.points[0]) < 7, 'route closure jumps across the graph');
});

test('bot collider is mutated in place while the bot advances', () => {
  const road = buildRoadGraph(streetGrid);
  const built = buildTraffic({ bots: [{ route: ['A', 'C', 'D', 'B'] }] }, road);
  const collider = built.colliders[0];
  const start = { x: collider.x, z: collider.z };
  for (let i = 0; i < 100; i++) built.fixedStep(1 / 50, null);
  assert.equal(built.colliders[0], collider);
  assert.ok(Math.hypot(collider.x - start.x, collider.z - start.z) > 1);
});

test('bots are centered in the right lane rather than on the centreline', () => {
  const road = buildRoadGraph(streetGrid);
  const route = ['A', 'C', 'D', 'B'];
  const built = buildTraffic({ bots: [{ route, start: 0 }] }, road);
  const path = resolveTrafficRoute(route, road);
  const center = path.points[0];
  const next = path.points[1];
  const tangent = next.clone().sub(center).normalize();
  const normal = { x: -tangent.z, z: tangent.x };
  const c = built.colliders[0];
  const lateral = (c.x - center.x) * normal.x + (c.z - center.z) * normal.z;
  assert.ok(Math.abs(lateral - road.width / 4) < 0.01,
    `bot lane offset is ${lateral.toFixed(2)}m, expected ${(road.width / 4).toFixed(2)}m`);
});

test('bots on equivalent fixed routes brake for one another', () => {
  const road = buildRoadGraph(streetGrid);
  const route = ['A', 'C', 'D', 'B'];
  const built = buildTraffic({ bots: [
    { id: 'leader', route, start: 0.1, speed: 0 },
    { id: 'follower', route: [...route], start: 0.08 },
  ] }, road);
  for (let i = 0; i < 100; i++) built.fixedStep(1 / 50, null);
  const follower = built.states().find(b => b.id === 'follower');
  assert.equal(follower.speed, 0, 'follower drove into a bot on the same fixed route');
});

test('bot spawn hints inside junctions are moved clear of every pad', () => {
  const road = buildRoadGraph(streetGrid);
  const built = buildTraffic({ bots: [{ route: ['A', 'C', 'D', 'B'], start: 0 }] }, road);
  const c = built.colliders[0];
  for (const node of road.graph.nodes) {
    const distance = Math.hypot(c.x - node.pos[0], c.z - node.pos[1]);
    assert.ok(distance > node.pad / 2,
      `bot spawned inside ${node.id}'s junction pad`);
  }
});

test('bot heading turns continuously through a junction', () => {
  const road = buildRoadGraph(streetGrid);
  const built = buildTraffic({ bots: [{ route: ['A', 'C', 'D', 'B'], start: 0 }] }, road);
  const mesh = built.group.children[0];
  let previous = mesh.rotation.y;
  let totalTurn = 0;
  let largestStep = 0;
  for (let i = 0; i < 800; i++) {
    built.fixedStep(1 / 50, null);
    let delta = mesh.rotation.y - previous;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    totalTurn += Math.abs(delta);
    largestStep = Math.max(largestStep, Math.abs(delta));
    previous = mesh.rotation.y;
  }
  assert.ok(totalTurn > 1, 'bot never reached a corner during the test');
  assert.ok(largestStep < 0.2,
    `bot heading snapped ${largestStep.toFixed(2)} radians in one tick`);
});

test('a red signal stops a bot before its next crossing', () => {
  const road = buildRoadGraph(streetGrid);
  const STOP_DISTANCE = 9;
  const context = { states: () => ['NS', 'EW'].map(axis => ({
    node: 'C', axis, phase: 'red', stopDistance: STOP_DISTANCE,
  })) };
  const built = buildTraffic({ bots: [{ route: ['A', 'C', 'D', 'B'], start: 0.12 }] }, road, context);
  for (let i = 0; i < 600; i++) built.fixedStep(1 / 50, null);
  const state = built.states()[0];
  assert.equal(state.speed, 0);
  const c = road.graph.nodes.find(n => n.id === 'C');
  const distanceFromJunction = Math.hypot(state.x - c.pos[0], state.z - c.pos[1]);
  assert.ok(distanceFromJunction > STOP_DISTANCE,
    `bot stopped ${distanceFromJunction.toFixed(2)}m from the junction, beyond the stop bar at ${STOP_DISTANCE}m`);
  assert.ok(distanceFromJunction < STOP_DISTANCE + 1.8,
    `bot stopped ${distanceFromJunction.toFixed(2)}m from the junction, too far before the stop bar`);
});
