import * as THREE from 'three';
import { circleCollider } from './collide.js';

const BOT_RADIUS = 0.72;
const DEFAULT_SPEED = 5.5;
const FOLLOW_GAP = 4.2;
// Bot position is its centre. Stop with the nose short of the painted bar,
// rather than putting the centre on it (or, previously, targeting the node
// centre and stopping inside the junction).
const STOP_LINE_BUFFER = 1.15;
const SIGNAL_LOOKAHEAD = 35;
const INDICATOR_PERIOD = 0.8;
const INDICATOR_ON = INDICATOR_PERIOD / 2;
const LAMP_OFF = 0x241d18;
const BRAKE_RED = 0xff2418;
const TURN_YELLOW = 0xffb51b;

function pushPoint(points, point, node = null) {
  const prev = points[points.length - 1];
  if (prev && prev.point.distanceToSquared(point) < 1e-8) {
    if (node) prev.node = node;
    return;
  }
  points.push({ point: point.clone(), node });
}

// Resolve node ids once, into a closed and genuinely continuous walk. Edge
// samples stop at pad boundaries, so the authored node centre bridges each
// pair of incident edges through the junction.
export function resolveTrafficRoute(nodeIds, road) {
  if (!road.graph) throw new Error('traffic routes require a road graph');
  if (!Array.isArray(nodeIds) || nodeIds.length < 3) throw new Error('traffic route needs at least three nodes');
  const points = [];
  const crossings = [];
  for (let i = 0; i < nodeIds.length; i++) {
    const from = nodeIds[i], to = nodeIds[(i + 1) % nodeIds.length];
    const edge = road.graph.edges.find(e =>
      (e.from === from && e.to === to) || (e.from === to && e.to === from));
    if (!edge) throw new Error(`traffic route has no edge ${from}<->${to}`);
    const samples = edge.from === from ? edge.centers : [...edge.centers].reverse();
    for (const p of samples) pushPoint(points, p);
    const node = road.graph.nodes.find(n => n.id === to);
    if (!node) throw new Error(`traffic route node "${to}" not found`);
    pushPoint(points, new THREE.Vector3(node.pos[0], 0, node.pos[1]), to);
  }
  const distances = [0];
  for (let i = 1; i < points.length; i++)
    distances[i] = distances[i - 1] + points[i - 1].point.distanceTo(points[i].point);
  const closing = points.at(-1).point.distanceTo(points[0].point);
  const length = distances.at(-1) + closing;
  for (let i = 0; i < points.length; i++) if (points[i].node) {
    const node = road.graph.nodes.find(n => n.id === points[i].node);
    crossings.push({ node: points[i].node, pad: node?.pad ?? 0, s: distances[i] });
  }
  return { points: points.map(p => p.point), distances, crossings, length };
}

function wrap(v, length) { return ((v % length) + length) % length; }
function ahead(from, to, length) { return wrap(to - from, length); }

function circularDistance(a, b, length) {
  const d = Math.abs(a - b);
  return Math.min(d, length - d);
}

function clearOfJunctions(path, s) {
  return path.crossings.every(crossing =>
    circularDistance(s, crossing.s, path.length) > crossing.pad / 2 + BOT_RADIUS);
}

// Fractions are convenient authoring hints, but route geometry can change.
// Move an unsafe hint forward until the entire bot is clear of every pad.
function safeSpawnPosition(path, requested) {
  let s = wrap(requested, path.length);
  for (let walked = 0; walked < path.length; walked += 0.25) {
    if (clearOfJunctions(path, s)) return s;
    s = wrap(s + 0.25, path.length);
  }
  throw new Error('traffic route has no spawn position outside its junctions');
}

function samplePolyline(path, s) {
  s = wrap(s, path.length);
  let i = 0;
  while (i + 1 < path.distances.length && path.distances[i + 1] <= s) i++;
  const j = (i + 1) % path.points.length;
  const a = path.points[i], b = path.points[j];
  const start = path.distances[i];
  const span = j ? path.distances[j] - start : path.length - start;
  const t = span > 1e-9 ? (s - start) / span : 0;
  return { point: a.clone().lerp(b, t), tangent: b.clone().sub(a).normalize() };
}

function signedDistance(from, to, length) {
  let d = wrap(to - from, length);
  if (d > length / 2) d -= length;
  return d;
}

function samplePath(path, s, lateral = 0) {
  s = wrap(s, path.length);
  let sampled = samplePolyline(path, s);

  // The resolved route is intentionally a simple connected polyline. Round
  // only the section inside each node pad: a quadratic Bezier is tangent to
  // the incoming and outgoing streets at its ends, so both position and yaw
  // remain continuous through a turn without changing route bookkeeping.
  for (const crossing of path.crossings) {
    const radius = Math.max(0, Math.min(4, crossing.pad / 2 - BOT_RADIUS));
    const delta = signedDistance(crossing.s, s, path.length);
    if (radius <= 0 || Math.abs(delta) >= radius) continue;
    const incoming = samplePolyline(path, crossing.s - radius).point;
    const outgoing = samplePolyline(path, crossing.s + radius).point;
    const control = samplePolyline(path, crossing.s).point;
    const t = (delta + radius) / (2 * radius);
    const u = 1 - t;
    const point = incoming.clone().multiplyScalar(u * u)
      .addScaledVector(control, 2 * u * t)
      .addScaledVector(outgoing, t * t);
    const tangent = control.clone().sub(incoming).multiplyScalar(2 * u)
      .add(outgoing.clone().sub(control).multiplyScalar(2 * t)).normalize();
    sampled = { point, tangent };
    break;
  }

  const { point, tangent } = sampled;
  // Same lateral convention as roadgraph/intersectionSignals: positive is
  // the right side in the direction of travel. Keeping the route itself on
  // the centreline preserves simple arc-distance bookkeeping; only the
  // rendered/collidable pose is shifted into its lane.
  point.addScaledVector(new THREE.Vector3(-tangent.z, 0, tangent.x), lateral);
  return { point, tangent };
}

function lampMesh(color, x, z, name) {
  const material = new THREE.MeshBasicMaterial({ color: LAMP_OFF });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.13, 0.06), material);
  mesh.position.set(x, 0.43, z);
  mesh.name = name;
  mesh.userData.onColor = color;
  return { mesh, material };
}

function botMesh(color) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.42, 1.85), new THREE.MeshLambertMaterial({ color }));
  body.position.y = 0.38; body.castShadow = true;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.3, 0.78), new THREE.MeshLambertMaterial({ color: 0x26303a }));
  cab.position.set(0, 0.68, -0.1); cab.castShadow = true;
  group.add(body, cab);
  const brakes = [
    lampMesh(BRAKE_RED, -0.25, -0.955, 'brake-left'),
    lampMesh(BRAKE_RED, 0.25, -0.955, 'brake-right'),
  ];
  const turns = {
    left: [
      lampMesh(TURN_YELLOW, -0.43, 0.955, 'turn-left-front'),
      lampMesh(TURN_YELLOW, -0.43, -0.955, 'turn-left-rear'),
    ],
    right: [
      lampMesh(TURN_YELLOW, 0.43, 0.955, 'turn-right-front'),
      lampMesh(TURN_YELLOW, 0.43, -0.955, 'turn-right-rear'),
    ],
  };
  for (const lamp of [...brakes, ...turns.left, ...turns.right]) group.add(lamp.mesh);
  return { group, brakes, turns };
}

function setLamps(lamps, on) {
  for (const lamp of lamps) lamp.material.color.setHex(on ? lamp.mesh.userData.onColor : LAMP_OFF);
}

function turnAt(path, crossing) {
  const radius = Math.max(0.5, Math.min(4, crossing.pad / 2 - BOT_RADIUS));
  const incoming = samplePolyline(path, crossing.s - radius).tangent;
  const outgoing = samplePolyline(path, crossing.s + radius).tangent;
  const cross = incoming.x * outgoing.z - incoming.z * outgoing.x;
  if (Math.abs(cross) < 0.25) return null;
  return cross > 0 ? 'left' : 'right';
}

export function buildTraffic(spec, road, context = { states: () => [] }) {
  if (!road.graph) throw new Error('traffic requires a road graph');
  const group = new THREE.Group();
  const colliders = [];
  const bots = (spec.bots || []).map((cfg, index) => {
    const path = resolveTrafficRoute(cfg.route, road);
    const visual = botMesh(cfg.color ?? [0xd85b45, 0x46a36f, 0xd3a936, 0x8d65bd][index % 4]);
    const mesh = visual.group;
    const s = safeSpawnPosition(path, (cfg.start ?? 0) * path.length);
    const collider = circleCollider(0, 0, BOT_RADIUS);
    group.add(mesh); colliders.push(collider);
    return {
      id: cfg.id || `bot-${index + 1}`, path,
      // Equivalent authored routes share a key even though each bot owns its
      // own resolved path object. This lets same-route following work for
      // fleets rather than only for bots handed the exact same object.
      routeKey: cfg.route.join('>'), mesh, collider, s, speed: 0,
      targetSpeed: cfg.speed ?? spec.speed ?? DEFAULT_SPEED,
      laneOffset: cfg.laneOffset ?? road.width / 4,
      visual, braking: false, turnSignal: null, blinkOn: false,
    };
  });

  function place(bot) {
    const { point, tangent } = samplePath(bot.path, bot.s, bot.laneOffset);
    bot.mesh.position.set(point.x, 0, point.z);
    bot.mesh.rotation.y = Math.atan2(tangent.x, tangent.z);
    bot.collider.x = point.x; bot.collider.z = point.z;
  }
  for (const bot of bots) place(bot);

  let indicatorTime = 0;
  function fixedStep(dt, player) {
    indicatorTime = wrap(indicatorTime + dt, INDICATOR_PERIOD);
    const signals = context.states('intersectionSignals');
    let visualChanged = false;
    for (const bot of bots) {
      let clearance = Infinity;
      // Anything physically ahead along this route, including the player.
      for (const other of bots) {
        if (other === bot || other.routeKey !== bot.routeKey) continue;
        clearance = Math.min(clearance, ahead(bot.s, other.s, bot.path.length) - FOLLOW_GAP);
      }
      if (player) {
        const here = samplePath(bot.path, bot.s, bot.laneOffset);
        const dx = player.x - here.point.x, dz = player.z - here.point.z;
        const forward = dx * here.tangent.x + dz * here.tangent.z;
        const lateral = Math.abs(dx * here.tangent.z - dz * here.tangent.x);
        if (forward > 0 && lateral < 2.2) clearance = Math.min(clearance, forward - FOLLOW_GAP);
      }
      for (const crossing of bot.path.crossings) {
        const d = ahead(bot.s, crossing.s, bot.path.length);
        if (d > SIGNAL_LOOKAHEAD) continue;
        const approach = samplePath(bot.path, Math.max(0, crossing.s - 0.2)).tangent;
        const axis = Math.abs(approach.x) > Math.abs(approach.z) ? 'EW' : 'NS';
        const signal = signals.find(s => s.node === crossing.node && s.axis === axis);
        if (signal && signal.phase !== 'green') {
          const stopDistance = signal.stopDistance ?? 0;
          clearance = Math.min(clearance, d - stopDistance - STOP_LINE_BUFFER);
        }
      }
      const desired = clearance <= 0 ? 0 : Math.min(bot.targetSpeed, Math.sqrt(2 * 3.5 * clearance));
      const wasBraking = bot.braking;
      bot.braking = desired < bot.speed - 1e-4;
      const accel = desired > bot.speed ? 2.2 : -4.5;
      bot.speed = Math.max(0, Math.min(desired, bot.speed + accel * dt));
      bot.s = wrap(bot.s + bot.speed * dt, bot.path.length);

      let turnSignal = null;
      for (const crossing of bot.path.crossings) {
        const turn = turnAt(bot.path, crossing);
        if (!turn) continue;
        const delta = signedDistance(crossing.s, bot.s, bot.path.length);
        const signal = signals.find(s => s.node === crossing.node);
        const stopDistance = signal?.stopDistance ?? crossing.pad / 2 + 3;
        const curveExit = Math.max(0.5, Math.min(4, crossing.pad / 2 - BOT_RADIUS));
        if (delta >= -(stopDistance + 2) && delta <= curveExit + 1) {
          turnSignal = turn;
          break;
        }
      }
      const blinkOn = !!turnSignal && indicatorTime < INDICATOR_ON;
      if (wasBraking !== bot.braking || bot.turnSignal !== turnSignal || bot.blinkOn !== blinkOn) visualChanged = true;
      bot.turnSignal = turnSignal;
      bot.blinkOn = blinkOn;
      setLamps(bot.visual.brakes, bot.braking);
      setLamps(bot.visual.turns.left, turnSignal === 'left' && blinkOn);
      setLamps(bot.visual.turns.right, turnSignal === 'right' && blinkOn);
      place(bot);
    }
    return visualChanged || bots.some(b => b.speed > 0);
  }

  return {
    group, colliders, fixedStep,
    states: () => bots.map(b => ({
      id: b.id, x: b.collider.x, z: b.collider.z, speed: b.speed,
      routePosition: b.s, braking: b.braking,
      turnSignal: b.turnSignal, blinkOn: b.blinkOn,
    })),
  };
}
