import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildRoadGraph } from '../sim/roadgraph.js';
import streetGrid from '../worlds/street-grid.js';

// Every painted marking is an InstancedMesh of flat PlaneGeometry, so the
// paint can be read back out of the built scene and measured rather than
// re-derived from the constants that drew it. Dashes and crosswalk stripes
// are told apart by stripe width, which is the one thing that differs.
const DASH_W = 0.22, CROSSWALK_W = 0.42;

function paintRects(group, stripeWidth) {
  const rects = [];
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  group.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const p = o.geometry.parameters;
    if (!p || Math.abs(p.width - stripeWidth) > 1e-6) return;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [lx, ly] of [[-p.width/2, -p.height/2], [p.width/2, -p.height/2],
                              [p.width/2, p.height/2], [-p.width/2, p.height/2]]) {
        v.set(lx, ly, 0).applyMatrix4(m);
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
      }
      rects.push({ minX, maxX, minZ, maxZ });
    }
  });
  return rects;
}

const overlaps = (a, b, eps = 1e-6) =>
  a.minX < b.maxX - eps && b.minX < a.maxX - eps &&
  a.minZ < b.maxZ - eps && b.minZ < a.maxZ - eps;

// The pieces that close the gap at a node are the only ShapeGeometry in the
// build, so they can be pulled back out and asked whether they actually
// cover a spot. Selected by height, because the kerb line and the footway
// are two separate bands carried through the same gap.
const EDGE_LINE_Y = 0.045;

function bandTriangles(group, y) {
  const tris = [];
  const v = new THREE.Vector3();
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    if (!o.isMesh || o.geometry.type !== 'ShapeGeometry') return;
    if (Math.abs(o.position.y - y) > 1e-6) return;
    const pos = o.geometry.getAttribute('position');
    const idx = o.geometry.getIndex();
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const t = [];
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k).applyMatrix4(o.matrixWorld);
        t.push([v.x, v.z]);
      }
      tris.push(t);
    }
  });
  return tris;
}

function covered(tris, x, z) {
  return tris.some(([[ax, az], [bx, bz], [cx, cz]]) => {
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) return false;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const w = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    return u >= -1e-9 && w >= -1e-9 && u + w <= 1 + 1e-9;
  });
}

// Outward unit directions from a node along each edge that touches it.
function armsAt(built, id) {
  const node = built.graph.nodes.find((n) => n.id === id);
  return built.graph.edges
    .filter((e) => e.from === id || e.to === id)
    .map((e) => (e.from === id
      ? e.tangents[0]
      : e.tangents[e.SAMPLES - 1].clone().negate()));
}

// Middle of the footway: half way between kerb and back edge.
const midOffset = (built, sw) => built.width / 2 + 0.05 + sw.width / 2;
// Middle of the painted road-edge line, just inside the kerb.
const edgeLineOffset = (built) => built.width / 2 - 0.115;

// Plain node:test, no browser -- sim/roadgraph.js only touches three.js's
// pure math/geometry classes (Vector3, CatmullRomCurve3, BufferGeometry,
// InstancedMesh, ...), same as sim/road.js, so this runs directly the way
// test/zip.test.js exercises a pure util module.

test('the street-grid world graph builds and the flattened array matches SAMPLES', () => {
  const built = buildRoadGraph(streetGrid);
  assert.equal(built.centers.length, built.SAMPLES);
  assert.equal(built.tangents.length, built.SAMPLES);
  assert.ok(built.SAMPLES > 0);
  assert.ok(built.startIdx >= 0 && built.startIdx < built.SAMPLES);
});

const degrees = (built) => {
  const degree = new Map(built.graph.nodes.map((n) => [n.id, 0]));
  for (const e of built.graph.edges) {
    degree.set(e.from, degree.get(e.from) + 1);
    degree.set(e.to, degree.get(e.to) + 1);
  }
  return degree;
};

test('the layout is 4-ways on the block, Ts on the ring, and bends at the ring corners', () => {
  const built = buildRoadGraph(streetGrid);
  const degree = degrees(built);
  for (const id of ['A', 'B', 'C', 'D']) {
    assert.equal(degree.get(id), 4, `block corner ${id} should be a 4-way, has degree ${degree.get(id)}`);
  }
  const ts = built.graph.nodes.filter((n) => n.id.startsWith('T_'));
  assert.equal(ts.length, 8, 'expected 8 T intersections');
  for (const n of ts) {
    assert.equal(degree.get(n.id), 3, `${n.id} should be a T, has degree ${degree.get(n.id)}`);
  }
  const bends = built.graph.nodes.filter((n) => n.id.startsWith('P_'));
  assert.equal(bends.length, 4, 'expected 4 ring corners');
  for (const n of bends) {
    assert.equal(degree.get(n.id), 2, `${n.id} should be a bend, has degree ${degree.get(n.id)}`);
  }
});

// The point of the ring: a street that just stops is a wall you can drive
// into at speed with no warning, and it makes half the layout a dead end
// to reverse out of. Every node must lead somewhere.
test('no street dead-ends -- every node has at least two ways out', () => {
  const built = buildRoadGraph(streetGrid);
  for (const [id, d] of degrees(built)) {
    assert.ok(d >= 2, `${id} is a dead end (degree ${d})`);
  }
});

// A bend's pad has to be the road width exactly, or it either leaves the
// notch it exists to fill or bulges past the kerb -- see the comment on
// buildIntersectionPad in sim/roadgraph.js.
test('ring corners are padded to the road width, junctions wider', () => {
  const built = buildRoadGraph(streetGrid);
  for (const n of built.graph.nodes) {
    if (n.id.startsWith('P_')) {
      assert.equal(n.pad, built.width, `bend ${n.id} pad must equal the road width`);
    } else {
      assert.ok(n.pad > built.width, `junction ${n.id} pad should overhang the kerb`);
    }
  }
});

test('per-edge globalOffset bookkeeping matches the flattened array', () => {
  const built = buildRoadGraph(streetGrid);
  let total = 0;
  for (const edge of built.graph.edges) {
    assert.equal(edge.globalOffset, total, `edge ${edge.id} offset out of order`);
    assert.equal(built.centers[edge.globalOffset].x, edge.centers[0].x);
    assert.equal(built.centers[edge.globalOffset].z, edge.centers[0].z);
    const lastLocal = edge.SAMPLES - 1;
    const lastGlobal = edge.globalOffset + lastLocal;
    assert.equal(built.centers[lastGlobal].x, edge.centers[lastLocal].x);
    assert.equal(built.centers[lastGlobal].z, edge.centers[lastLocal].z);
    total += edge.SAMPLES;
  }
  assert.equal(total, built.SAMPLES);
});

// The trim is what makes a junction look like a junction: each edge has to
// stop exactly on the pad boundary. Short and the asphalt has a seam of
// bare ground across it; long and the ribbon runs out over the pad and
// paints its edge lines through the middle of the intersection.
test('every edge stops exactly on the boundary of the pad it runs into', () => {
  const built = buildRoadGraph(streetGrid);
  const byId = new Map(built.graph.nodes.map((n) => [n.id, n]));
  for (const edge of built.graph.edges) {
    for (const [nodeId, sample] of [[edge.from, edge.centers[0]],
                                    [edge.to, edge.centers[edge.SAMPLES - 1]]]) {
      const node = byId.get(nodeId);
      const gap = Math.hypot(sample.x - node.pos[0], sample.z - node.pos[1]);
      assert.ok(Math.abs(gap - node.pad / 2) < 1e-6,
        `edge ${edge.id} ends ${gap.toFixed(3)}m from ${nodeId}, expected exactly ${node.pad / 2}`);
    }
  }
});

// The centerline used to be placed every Nth sample and centred on the
// edge's last sample, so a dash hung half its length into the junction and
// painted straight over the crosswalk beyond it.
test('no centerline dash reaches into an intersection pad', () => {
  const built = buildRoadGraph(streetGrid);
  const dashes = paintRects(built.group, DASH_W);
  assert.ok(dashes.length > 0, 'no centerline dashes were built at all');

  for (const n of built.graph.nodes) {
    if (n.pad <= 0) continue;
    const pad = {
      minX: n.pos[0] - n.pad / 2, maxX: n.pos[0] + n.pad / 2,
      minZ: n.pos[1] - n.pad / 2, maxZ: n.pos[1] + n.pad / 2,
    };
    for (const d of dashes) {
      assert.ok(!overlaps(d, pad),
        `a dash at (${d.minX.toFixed(2)}, ${d.minZ.toFixed(2)}) reaches into the pad at ${n.id}`);
    }
  }
});

test('no centerline dash overlaps a crosswalk', () => {
  const built = buildRoadGraph(streetGrid);
  const dashes = paintRects(built.group, DASH_W);
  const walks = paintRects(built.group, CROSSWALK_W);
  assert.ok(walks.length > 0, 'no crosswalk stripes were built at all');

  for (const d of dashes) {
    for (const w of walks) {
      assert.ok(!overlaps(d, w),
        `a dash at (${d.minX.toFixed(2)}, ${d.minZ.toFixed(2)}) overlaps a crosswalk stripe`);
    }
  }
});

// Each edge's sidewalk stops at the pad, so a node is left with a hole in
// the footway. At the back of a T nothing crosses, so the footway has to
// carry straight on rather than stop dead either side of the junction.
test('the footway carries across the back of every T', () => {
  const built = buildRoadGraph(streetGrid);
  const tris = bandTriangles(built.group, streetGrid.sidewalk.height);
  const off = midOffset(built, streetGrid.sidewalk);
  const tees = built.graph.nodes.filter((n) => n.id.startsWith('T_'));
  assert.equal(tees.length, 8);

  for (const node of tees) {
    const arms = armsAt(built, node.id);
    // The branch is the approach with nothing opposite it; the unbroken
    // side of the footway is the one facing away from it.
    const branch = arms.find((d) => !arms.some((o) => o.dot(d) < -0.99));
    assert.ok(branch, `${node.id} has no through road -- not a T`);
    const x = node.pos[0] - branch.x * off, z = node.pos[1] - branch.z * off;
    assert.ok(covered(tris, x, z),
      `${node.id}: footway is broken behind the junction at (${x.toFixed(2)}, ${z.toFixed(2)})`);
  }
});

test('the footway wraps the outside of every ring corner', () => {
  const built = buildRoadGraph(streetGrid);
  const tris = bandTriangles(built.group, streetGrid.sidewalk.height);
  const off = midOffset(built, streetGrid.sidewalk);
  const bends = built.graph.nodes.filter((n) => n.id.startsWith('P_'));
  assert.equal(bends.length, 4);

  for (const node of bends) {
    const [a, b] = armsAt(built, node.id);
    // Outside of the corner: back along both approaches at once.
    const x = node.pos[0] - (a.x + b.x) * off;
    const z = node.pos[1] - (a.z + b.z) * off;
    assert.ok(covered(tris, x, z),
      `${node.id}: footway does not wrap the outside corner at (${x.toFixed(2)}, ${z.toFixed(2)})`);
  }
});

// The white kerb line is a separate band of the cross-section from the
// footway, and it stops at the pad for the same reason. Wherever the
// footway carries through, the line beside it has to as well, or the road
// loses its edge exactly where it widens into a junction.
test('the painted road edge carries through wherever the footway does', () => {
  const built = buildRoadGraph(streetGrid);
  const tris = bandTriangles(built.group, EDGE_LINE_Y);
  const off = edgeLineOffset(built);

  for (const node of built.graph.nodes.filter((n) => n.id.startsWith('T_'))) {
    const arms = armsAt(built, node.id);
    const branch = arms.find((d) => !arms.some((o) => o.dot(d) < -0.99));
    const x = node.pos[0] - branch.x * off, z = node.pos[1] - branch.z * off;
    assert.ok(covered(tris, x, z),
      `${node.id}: road edge line is broken behind the junction at (${x.toFixed(2)}, ${z.toFixed(2)})`);
  }

  for (const node of built.graph.nodes.filter((n) => n.id.startsWith('P_'))) {
    const [a, b] = armsAt(built, node.id);
    const x = node.pos[0] - (a.x + b.x) * off, z = node.pos[1] - (a.z + b.z) * off;
    assert.ok(covered(tris, x, z),
      `${node.id}: road edge line does not wrap the outside corner at (${x.toFixed(2)}, ${z.toFixed(2)})`);
  }
});

// The carried-through piece has to line up with the ribbon the edge itself
// lays down, or the marking visibly steps sideways at the pad boundary.
test('the carried-through edge line meets the edge’s own at the pad boundary', () => {
  const built = buildRoadGraph(streetGrid);
  const tris = bandTriangles(built.group, EDGE_LINE_Y);
  const off = edgeLineOffset(built);
  const node = built.graph.nodes.find((n) => n.id === 'T_n_w');
  const arms = armsAt(built, node.id);
  const branch = arms.find((d) => !arms.some((o) => o.dot(d) < -0.99));

  // Walk the back of the junction from one pad edge to the other; the line
  // must be unbroken the whole way across. Inset a hair at each end: those
  // are the seams where the edge's own ribbon takes over, and landing a
  // sample exactly on one is a float coin-toss, not a gap.
  const SEAM = 0.01;
  for (let t = -node.pad / 2 + SEAM; t <= node.pad / 2 - SEAM; t += 0.5) {
    const along = arms.find((d) => Math.abs(d.dot(branch)) < 0.01);
    const x = node.pos[0] - branch.x * off + along.x * t;
    const z = node.pos[1] - branch.z * off + along.z * t;
    assert.ok(covered(tris, x, z),
      `gap in the carried edge line at (${x.toFixed(2)}, ${z.toFixed(2)})`);
  }
});

// The junction pad overhangs the kerb, and that overhang used to show
// through as a square bite of asphalt out of the corner of the footway.
// It should instead be a kerb return: the footway rounded off on an arc,
// with the roadway keeping the rounded corner.
test('junction corners are rounded to a kerb radius, not left square', () => {
  const built = buildRoadGraph(streetGrid);
  const tris = bandTriangles(built.group, streetGrid.sidewalk.height);
  const kerb = built.width / 2 + 0.05;

  for (const id of ['A', 'B', 'C', 'D']) {
    const node = built.graph.nodes.find((n) => n.id === id);
    const arms = armsAt(built, id);
    const radius = node.pad / 2 - kerb;
    assert.ok(radius > 0.5, `${id}: pad leaves only ${radius.toFixed(2)}m for a kerb return`);

    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        const a = arms[i], b = arms[j];
        if (Math.abs(a.dot(b)) > 0.01) continue;   // not a right-angle pair
        // Centre of the arc: out along both kerbs at once.
        const cx = node.pos[0] + (a.x + b.x) * (kerb + radius);
        const cz = node.pos[1] + (a.z + b.z) * (kerb + radius);
        // Diagonal back toward the junction, the direction the corner is
        // cut off in.
        const dx = -(a.x + b.x) / Math.SQRT2, dz = -(a.z + b.z) / Math.SQRT2;

        const inside = [cx + dx * radius * 0.8, cz + dz * radius * 0.8];
        const outside = [cx + dx * radius * 1.2, cz + dz * radius * 1.2];
        assert.ok(covered(tris, inside[0], inside[1]),
          `${id}: footway missing inside the kerb return at (${inside[0].toFixed(2)}, ${inside[1].toFixed(2)})`);
        assert.ok(!covered(tris, outside[0], outside[1]),
          `${id}: footway still square past the kerb radius at (${outside[0].toFixed(2)}, ${outside[1].toFixed(2)})`);
      }
    }
  }
});

test('normalAt is perpendicular to the tangent at the same index', () => {
  const built = buildRoadGraph(streetGrid);
  for (const i of [0, built.startIdx, built.SAMPLES - 1]) {
    const t = built.tangents[i], n = built.normalAt(i);
    const dot = t.x * n.x + t.z * n.z;
    assert.ok(Math.abs(dot) < 1e-6, `sample ${i}: tangent/normal not perpendicular (dot=${dot})`);
  }
});

// A bend gets asphalt but no paint; a junction gets both. Gating those
// together is what left a notch bitten out of every ring corner.
test('a bend gets a pad but no crosswalks; a junction gets pad plus one band per approach', () => {
  const MESHES_PER_EDGE = 4; // asphalt + 2 edge-line ribbons + dashed centerline (no sidewalk configured)

  const bend = buildRoadGraph({
    width: 6,
    graph: {
      nodes: [
        { id: 'n1', pos: [0, 0], pad: 6 },
        { id: 'n2', pos: [-20, 0], pad: 0 },
        { id: 'n3', pos: [0, 20], pad: 0 },
      ],
      edges: [
        { id: 'e1', from: 'n2', to: 'n1' },
        { id: 'e2', from: 'n1', to: 'n3' },
      ],
    },
  });
  // Pad, plus one carried-through edge line wrapping the outside of the
  // corner. No crosswalks, and no footway piece -- this spec has no
  // sidewalk configured, so that band isn't in play.
  assert.equal(bend.group.children.length - bend.graph.edges.length * MESHES_PER_EDGE, 1 + 1,
    'a bend should get a pad and an edge line round the outside, and no crosswalks');

  const tee = buildRoadGraph({
    width: 6,
    graph: {
      nodes: [
        { id: 'n1', pos: [0, 0], pad: 9 },
        { id: 'n2', pos: [-20, 0], pad: 0 },
        { id: 'n3', pos: [20, 0], pad: 0 },
        { id: 'n4', pos: [0, 20], pad: 0 },
      ],
      edges: [
        { id: 'e1', from: 'n2', to: 'n1' },
        { id: 'e2', from: 'n1', to: 'n3' },
        { id: 'e3', from: 'n1', to: 'n4' },
      ],
    },
  });
  // Pad, one crosswalk band per approach, the edge line carried across the
  // back of the T (its one gap wider than a right angle), and a kerb return
  // at each of its two right-angle corners.
  const extra = tee.group.children.length - tee.graph.edges.length * MESHES_PER_EDGE;
  assert.equal(extra, 1 + 3 + 1 + 2,
    'expected a pad, a crosswalk per approach, the edge line across the back, and two kerb returns');
});

// A dead end is legal geometry -- the builder must not invent a pad to
// join a single edge to nothing.
test('a dead end gets no pad', () => {
  const MESHES_PER_EDGE = 4;
  const stub = buildRoadGraph({
    width: 6,
    graph: {
      nodes: [
        { id: 'n1', pos: [0, 0], pad: 9 },
        { id: 'n2', pos: [-20, 0], pad: 9 },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    },
  });
  assert.equal(stub.group.children.length, MESHES_PER_EDGE,
    'a lone edge should get no pad geometry at either end');
});

test('an edge referencing an unknown node throws', () => {
  assert.throws(() => buildRoadGraph({
    graph: {
      nodes: [{ id: 'n1', pos: [0, 0], pad: 9 }],
      edges: [{ id: 'e1', from: 'n1', to: 'nope' }],
    },
  }), /unknown node/);
});

test('a duplicate node id throws', () => {
  assert.throws(() => buildRoadGraph({
    graph: {
      nodes: [{ id: 'n1', pos: [0, 0] }, { id: 'n1', pos: [10, 0] }],
      edges: [],
    },
  }), /duplicate node/);
});

test('a duplicate edge id throws', () => {
  assert.throws(() => buildRoadGraph({
    graph: {
      nodes: [
        { id: 'n1', pos: [0, 0], pad: 0 },
        { id: 'n2', pos: [20, 0], pad: 0 },
        { id: 'n3', pos: [0, 20], pad: 0 },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e1', from: 'n1', to: 'n3' },
      ],
    },
  }), /duplicate edge/);
});

test('nodes too close together for their pads throws instead of building degenerate geometry', () => {
  assert.throws(() => buildRoadGraph({
    graph: {
      nodes: [
        { id: 'n1', pos: [0, 0], pad: 9 },
        { id: 'n2', pos: [1, 0], pad: 9 },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    },
  }), /after pad trim/);
});
