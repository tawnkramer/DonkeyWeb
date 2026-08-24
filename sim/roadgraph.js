import * as THREE from 'three';
import { buildRibbon, buildWidthScale, buildDashedCenterline, DEFAULT_COLORS } from './road.js';

// ---------- road graph builder ----------
// buildRoad() draws one closed spline; that's a deliberate limit (see the
// header comment in worlds/city.js) and it stays that way -- every loop
// world still goes through it unchanged. This is the graph-shaped sibling
// for worlds that branch: a spec.graph of nodes (intersections) and edges
// (straight street segments between them), instead of a single spec.ctrl.
//
// Each edge is built exactly like a road, just open instead of closed --
// buildRibbon/buildWidthScale (factored out of road.js for this) take a
// `closed` flag for exactly that difference. What's genuinely new here is
// stitching edges together at nodes and flattening the result back into the
// single centers/tangents/SAMPLES array that car.js, recovery.js and the
// generic world tests still expect (see the "flattened compatibility view"
// section below for what that array does and doesn't promise).
//
// v1 scope, deliberately: nodes/edges are meant for a rectilinear grid.
// Edges are assumed straight (two-point Catmull-Rom) and node pads are
// axis-aligned squares -- fine for the streets this is built for, and a lot
// simpler than a general rotated-polygon intersection footprint that
// nothing here needs yet.

const DEFAULT_SAMPLES_PER_M = 2;   // matches the loop worlds' sample density
const DEFAULT_PAD = 9;
const CROSSWALK_STRIPE_LEN = 2.2;
const CROSSWALK_STRIPE_W = 0.42;
const CROSSWALK_GAP = 0.55;
const CROSSWALK_MARGIN = 0.3;      // clear of the road's own painted edge line
const CROSSWALK_SETBACK = 0.25;    // bare asphalt between the pad and the stripes
export const CROSSWALK_OUTER_M = CROSSWALK_SETBACK + CROSSWALK_STRIPE_LEN;

// Bare road to leave at an edge's end, so the centerline stops short of the
// junction instead of running into it. An edge is already trimmed to the
// pad boundary, so 0 would put a dash hard against the intersection (and,
// at a junction, straight across the crosswalk beyond it).
const DASH_CLEAR_JUNCTION = CROSSWALK_SETBACK + CROSSWALK_STRIPE_LEN + 0.5;
const DASH_CLEAR_BEND = 0.6;       // no crosswalk to clear, just the pad

function dashClearance(degree) {
  if (degree >= 3) return DASH_CLEAR_JUNCTION;   // pad + crosswalk
  if (degree === 2) return DASH_CLEAR_BEND;      // pad only
  return 0;                                      // dead end: no pad at all
}

// Builds one open edge: ribbon meshes + sampled centers/tangents, trimmed
// back from each endpoint's raw node position by that node's own pad
// half-extent, so the drivable surface starts/ends at the pad boundary
// instead of overlapping it or leaving a gap the ribbon doesn't cover.
function buildEdge(espec, fromNode, toNode, defaultWidth, colors, sidewalk, degreeOf) {
  const width = espec.width ?? defaultWidth;
  const p0 = new THREE.Vector3(fromNode.pos[0], 0, fromNode.pos[1]);
  const p1 = new THREE.Vector3(toNode.pos[0], 0, toNode.pos[1]);
  const dir = p1.clone().sub(p0).normalize();
  const start = p0.clone().addScaledVector(dir, fromNode.pad / 2);
  const end = p1.clone().addScaledVector(dir, -toNode.pad / 2);
  // Signed length along `dir`, not start.distanceTo(end): if the two pads
  // are big enough (or the nodes close enough) that the trim points cross
  // over, the segment would run backwards -- a plain distance would still
  // read as a large positive number and hide exactly that.
  const length = end.clone().sub(start).dot(dir);
  if (length < 0.5) {
    throw new Error(`edge ${espec.id} (${espec.from}->${espec.to}) is only ${length.toFixed(2)}m after pad trim -- nodes too close together or pads too large`);
  }

  const SAMPLES = Math.max(2, Math.round(length * (espec.samplesPerM ?? DEFAULT_SAMPLES_PER_M)));
  const curve = new THREE.CatmullRomCurve3([start, end], false, 'centripetal');
  const centers = [], tangents = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = i / (SAMPLES - 1);
    centers.push(curve.getPoint(t));
    tangents.push(curve.getTangent(t).normalize());
  }
  const normalAt = i => new THREE.Vector3(-tangents[i].z, 0, tangents[i].x);
  const MAX_OFFSET = width / 2 + 0.05 + (sidewalk ? sidewalk.width : 0);
  const widthScale = buildWidthScale(centers, tangents, SAMPLES, false, MAX_OFFSET);

  const meshes = [];
  const ribbon = (halfInner, halfOuter, y, color) =>
    buildRibbon(centers, normalAt, widthScale, SAMPLES, false, halfInner, halfOuter, y, color);
  meshes.push(ribbon(-width/2, width/2, 0.02, colors.asphalt));
  meshes.push(ribbon( width/2-0.28,  width/2+0.05, 0.045, colors.edge));
  meshes.push(ribbon(-width/2-0.05, -width/2+0.28, 0.045, colors.edge));
  if (sidewalk) {
    const inner = width/2 + 0.05, outer = inner + sidewalk.width;
    meshes.push(ribbon(inner, outer, sidewalk.height, sidewalk.color));
    meshes.push(ribbon(-outer, -inner, sidewalk.height, sidewalk.color));
  }
  // Open, and held back from whatever sits at each end -- see the note on
  // buildDashedCenterline. A short edge may come out with no dashes at all,
  // which is a legitimate result rather than a failure.
  const dashes = buildDashedCenterline(centers, tangents, SAMPLES, colors.center, {
    closed: false,
    startClear: dashClearance(degreeOf(espec.from)),
    endClear: dashClearance(degreeOf(espec.to)),
  });
  if (dashes) meshes.push(dashes);

  return {
    id: espec.id, from: espec.from, to: espec.to,
    width, SAMPLES, centers, tangents, normalAt,
    meshes,
  };
}

// A crosswalk band: stripes running ALONG the direction of travel (a real
// zebra crossing's stripe axis), spread across the road's width. Same
// "instanced flat plane, laid flat, aimed along a direction vector"
// technique as the dashed centerline / checker strip in road.js -- just
// aimed across the road instead of along it, with the instances spread
// along the normal instead of the tangent.
function buildCrosswalk(pos, dir, width, color) {
  const n = new THREE.Vector3(-dir.z, 0, dir.x);
  const usable = Math.max(0, width - 2 * CROSSWALK_MARGIN);
  const pitch = CROSSWALK_STRIPE_W + CROSSWALK_GAP;
  const count = Math.max(3, Math.floor(usable / pitch) + 1);
  const geo = new THREE.PlaneGeometry(CROSSWALK_STRIPE_W, CROSSWALK_STRIPE_LEN);
  const mat = new THREE.MeshBasicMaterial({ color });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
  const M = new THREE.Matrix4();
  for (let k = 0; k < count; k++) {
    const off = (k - (count - 1) / 2) * pitch;
    const p = pos.clone().addScaledVector(n, off);
    M.compose(new THREE.Vector3(p.x, 0.05, p.z), q, new THREE.Vector3(1, 1, 1));
    mesh.setMatrixAt(k, M);
  }
  return mesh;
}

// The direction pointing AWAY from `node` along `edge`, and the edge sample
// nearest that node -- used to plant a crosswalk band just outside the pad.
// An edge's samples run from its `from` node to its `to` node in order, so
// which end is "near this node" and which way is "outward" depends on
// whether the node is the edge's from or to.
function outwardFromNode(node, edge) {
  if (edge.from === node.id) {
    return { near: edge.centers[0], dir: edge.tangents[0] };
  }
  const last = edge.SAMPLES - 1;
  return { near: edge.centers[last], dir: edge.tangents[last].clone().negate() };
}

// The pad itself (flat asphalt square) plus, at a real junction, one
// crosswalk band per incident edge planted just outside the pad boundary.
//
// The two are gated separately on purpose. A degree-2 node is a BEND, not
// a junction: it gets the asphalt (without it, two straight ribbons meeting
// at a right angle leave a triangular notch bitten out of the outside of
// the corner) but no crosswalks, because nothing crosses there. Crosswalks
// need 3+ incident edges. A degree-1 node is a dead end and gets neither --
// there is nothing to join.
//
// A bend's pad must be sized to the road WIDTH, not to a junction's more
// generous pad: at a 90deg corner a width-sized square is exactly the
// corner square, so both ribbons land flush on its edges. Anything larger
// bulges past the kerb, anything smaller leaves the notch it was meant to
// fill. Junctions want the opposite -- a pad a metre or so wider than the
// road, so the overhang reads as the corner kerb returns.
function buildIntersectionPad(node, incidentEdges, colors) {
  const meshes = [];
  if (incidentEdges.length < 2 || node.pad <= 0) return meshes;

  const padGeo = new THREE.PlaneGeometry(node.pad, node.pad);
  const padMesh = new THREE.Mesh(padGeo, new THREE.MeshLambertMaterial({ color: colors.asphalt, side: THREE.DoubleSide }));
  padMesh.rotation.x = -Math.PI / 2;
  padMesh.position.set(node.pos[0], 0.025, node.pos[1]);
  padMesh.receiveShadow = true;
  meshes.push(padMesh);

  if (incidentEdges.length >= 3) {
    for (const edge of incidentEdges) {
      const { near, dir } = outwardFromNode(node, edge);
      const pos = near.clone().addScaledVector(dir, CROSSWALK_STRIPE_LEN / 2 + CROSSWALK_SETBACK);
      meshes.push(buildCrosswalk(pos, dir, edge.width, colors.edge));
    }
  }
  return meshes;
}

// An edge's sidewalk ribbons stop at the pad, the same as its asphalt, so
// every node is left with a hole in the kerbside -- both in the white edge
// line and in the footway beyond it. How big depends on the angle between
// the two approaches either side of it:
//
//   90deg  (the corners of a 4-way, a T, or the inside of a bend) -- the
//          two sides already run past each other and meet, because the
//          kerb sits further out than the pad does. Only a small square
//          notch is left, and filling it properly needs a polygon union.
//          Left alone.
//   180deg (the back of a T, where no side street interrupts) -- a clean
//          gap the width of the pad. Both should just carry on.
//   270deg (the outside of a bend) -- both should wrap the corner.
//
// So anything wider than a right angle gets filled, and one construction
// covers every case: walk the two inner edges of the band to where they
// meet, and the two outer edges to where THEY meet, and what lies between
// is the missing piece. When the approaches are opposite, neither pair
// meets and the piece degenerates to the straight strip that carrying a
// marking across a T's back is.
const CORNER_FILL_MIN_GAP = (100 * Math.PI) / 180;

// Anything narrower than that is a junction corner, and gets a rounded kerb
// return instead -- see buildKerbReturn. Capped by how far the pad overhangs
// the kerb, so this is a ceiling rather than a promise.
const KERB_RADIUS = 2.4;
const KERB_ARC_SEGMENTS = 12;

// Where two lines meet, or null if they're parallel -- which is exactly
// the "carry straight on" case above, not an error.
function meet(p, dp, q, dq) {
  const den = dp.x * dq.z - dp.z * dq.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q.x - p.x) * dq.z - (q.z - p.z) * dq.x) / den;
  return new THREE.Vector3(p.x + t * dp.x, 0, p.z + t * dp.z);
}

// A flat polygon on the ground plane. ShapeGeometry rather than a triangle
// fan: the wrap-around-a-corner piece is L-shaped, and fanning from one
// vertex of a concave polygon spills triangles outside it. The shape is
// built in (x, -z) because rotating -90deg about X maps local +y to world
// -z, so feeding it +z would mirror the piece about the node.
function flatPolygon(points, y, color) {
  const shape = new THREE.Shape(points.map(p => new THREE.Vector2(p.x, -p.z)));
  const mesh = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.receiveShadow = true;
  return mesh;
}

// `bands` describes the slices of the cross-section to carry through the
// gap, each as a pair of lateral offsets measured from the edge's centre.
// They're functions of the edge width rather than fixed numbers because two
// streets of different widths can meet at one node, and each side's marking
// has to start from its own kerb.
function buildCornerFills(node, incidentEdges, bands) {
  const meshes = [];
  if (incidentEdges.length < 2) return meshes;

  const arms = incidentEdges.map((edge) => {
    const { near, dir } = outwardFromNode(node, edge);
    return {
      near, dir, width: edge.width,
      // dir rotated a quarter turn anticlockwise, matching normalAt()
      n: new THREE.Vector3(-dir.z, 0, dir.x),
      angle: Math.atan2(dir.z, dir.x),
    };
  }).sort((a, b) => a.angle - b.angle);

  const corner = (arm, side, off) => new THREE.Vector3(
    arm.near.x + side * off * arm.n.x, 0, arm.near.z + side * off * arm.n.z);

  for (let i = 0; i < arms.length; i++) {
    const A = arms[i], B = arms[(i + 1) % arms.length];
    let gap = B.angle - A.angle;
    if (gap <= 0) gap += Math.PI * 2;

    // Sorted anticlockwise, so the gap runs off A's +n flank and into B's
    // -n flank. Getting these two signs the same way round builds the
    // piece on the wrong side of the junction, out in the road.
    if (gap >= CORNER_FILL_MIN_GAP) {
      for (const band of bands) {
        const aIn = corner(A, +1, band.inner(A.width)), aOut = corner(A, +1, band.outer(A.width));
        const bIn = corner(B, -1, band.inner(B.width)), bOut = corner(B, -1, band.outer(B.width));
        const I = meet(aIn, A.dir, bIn, B.dir);
        const O = meet(aOut, A.dir, bOut, B.dir);
        meshes.push(flatPolygon(
          I && O ? [aIn, I, bIn, bOut, O, aOut] : [aIn, bIn, bOut, aOut],
          band.y, band.color));
      }
      continue;
    }

    for (const m of buildKerbReturn(node, A, B, gap, corner, bands)) meshes.push(m);
  }
  return meshes;
}

// The corner of a junction, where two streets meet at roughly a right
// angle. The two sidewalks already overlap here, so there is no strip
// missing -- but the pad overhangs the kerb, and that overhang shows
// through as a square bite of asphalt taken out of the corner of the
// footway. A real kerb doesn't turn a square corner; it runs out on an arc
// tangent to both kerb lines, and the roadway keeps the rounded corner.
//
// How much radius is available is set by exactly that overhang. The arc has
// to stay inside the bare corner the pad leaves, because outside it the
// straight ribbons have already painted a square corner and nothing here
// can take paint away. So the radius is capped at what fits, and a junction
// that wants a rounder kerb needs a wider pad -- see JUNCTION_PAD in
// worlds/street-grid.js, which is sized from the radius for that reason.
// Where the sidewalks meet with no overhang at all (a bend, whose pad is
// only as wide as the road) the cap comes out at zero and nothing is drawn.
function buildKerbReturn(node, A, B, gap, corner, bands) {
  const meshes = [];
  const kerb = A.width / 2 + 0.05;
  const aKerb = corner(A, +1, kerb), bKerb = corner(B, -1, B.width / 2 + 0.05);
  const I = meet(aKerb, A.dir, bKerb, B.dir);
  if (!I) return meshes;

  // How far each kerb runs from the corner point before the straight ribbon
  // takes over, and the tangent length a radius needs at this angle.
  const runA = (aKerb.x - I.x) * A.dir.x + (aKerb.z - I.z) * A.dir.z;
  const runB = (bKerb.x - I.x) * B.dir.x + (bKerb.z - I.z) * B.dir.z;
  const halfAngle = Math.tan(gap / 2);
  const radius = Math.min(KERB_RADIUS, Math.min(runA, runB) * halfAngle);
  if (radius <= 0.05) return meshes;

  const tangent = radius / halfAngle;
  const Ta = new THREE.Vector3(I.x + tangent * A.dir.x, 0, I.z + tangent * A.dir.z);
  const C = new THREE.Vector3(Ta.x + radius * A.n.x, 0, Ta.z + radius * A.n.z);

  // The arc always runs from straight off A's flank to straight off B's, so
  // its endpoints are fixed by the normals and don't move with the radius.
  const from = Math.atan2(-A.n.z, -A.n.x);
  let sweep = Math.atan2(B.n.z, B.n.x) - from;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;

  const arc = (r, reverse) => {
    const pts = [];
    for (let s = 0; s <= KERB_ARC_SEGMENTS; s++) {
      const k = reverse ? KERB_ARC_SEGMENTS - s : s;
      const ang = from + sweep * (k / KERB_ARC_SEGMENTS);
      pts.push(new THREE.Vector3(C.x + r * Math.cos(ang), 0, C.z + r * Math.sin(ang)));
    }
    return pts;
  };

  // A lateral offset maps to a radius about the arc centre: the kerb itself
  // sits at `radius`, and anything nearer the road sits further out.
  const radiusAt = off => (kerb + radius) - off;
  const half = node.pad / 2;
  // The far corner of the pad, where the two straight ribbons' ends meet.
  const padCorner = new THREE.Vector3(
    node.pos[0] + half * (A.dir.x + B.dir.x), 0,
    node.pos[1] + half * (A.dir.z + B.dir.z));

  for (const band of bands) {
    const offNear = band.inner(A.width), offFar = band.outer(A.width);
    const rNear = radiusAt(offNear);
    if (rNear <= 0) continue;

    // Out to the pad boundary at each end, not just to the tangent point:
    // the radius is capped below what the pad leaves bare, so stopping at
    // the tangent leaves a sliver of pad showing between this piece and the
    // straight ribbon it hands off to.
    const points = [corner(A, +1, offNear), ...arc(rNear, false), corner(B, -1, offNear)];
    const rFar = radiusAt(offFar);
    if (rFar > 1e-6 && offFar < half) {
      points.push(corner(B, -1, offFar), ...arc(rFar, true), corner(A, +1, offFar));
    } else {
      // The band's back edge runs past the pad corner (the footway's does),
      // so it is clipped there -- beyond it the straight ribbons already
      // cover, and overlapping them would z-fight at the same height.
      points.push(padCorner);
    }
    meshes.push(flatPolygon(points, band.y, band.color));
  }
  return meshes;
}

export function buildRoadGraph(spec) {
  const g = spec.graph;
  const width = spec.width ?? 7;
  const colors = { ...DEFAULT_COLORS, ...(spec.colors || {}) };
  const sidewalk = spec.sidewalk ? { width: 2.4, height: 0.14, color: 0x8d8f8a, ...spec.sidewalk } : null;

  const nodeById = new Map();
  for (const n of g.nodes) {
    if (nodeById.has(n.id)) throw new Error(`duplicate node id: ${n.id}`);
    nodeById.set(n.id, { id: n.id, pos: n.pos, type: n.type ?? 'plain', pad: n.pad ?? DEFAULT_PAD });
  }

  // Degree up front, before any edge is built: an edge's centerline has to
  // be held back by different amounts depending on whether it runs into a
  // junction (pad + crosswalk), a bend (pad only) or a dead end (neither),
  // and that is a property of the node, not of the edge asking.
  const degree = new Map([...nodeById.keys()].map(id => [id, 0]));
  for (const espec of g.edges) {
    if (degree.has(espec.from)) degree.set(espec.from, degree.get(espec.from) + 1);
    if (degree.has(espec.to)) degree.set(espec.to, degree.get(espec.to) + 1);
  }
  const degreeOf = id => degree.get(id) ?? 0;

  const group = new THREE.Group();
  const edges = [];
  const seenEdgeIds = new Set();
  const allCenters = [], allTangents = [];

  for (const espec of g.edges) {
    if (seenEdgeIds.has(espec.id)) throw new Error(`duplicate edge id: ${espec.id}`);
    seenEdgeIds.add(espec.id);
    const fromNode = nodeById.get(espec.from), toNode = nodeById.get(espec.to);
    if (!fromNode) throw new Error(`edge ${espec.id} references unknown node "${espec.from}"`);
    if (!toNode) throw new Error(`edge ${espec.id} references unknown node "${espec.to}"`);

    const edge = buildEdge(espec, fromNode, toNode, width, colors, sidewalk, degreeOf);
    edge.globalOffset = allCenters.length;
    for (const m of edge.meshes) group.add(m);
    for (let i = 0; i < edge.SAMPLES; i++) {
      allCenters.push(edge.centers[i]);
      allTangents.push(edge.tangents[i]);
    }
    edges.push(edge);
  }

  // Offsets and heights here have to match the ribbons buildEdge lays down
  // on the straights, or the marking steps sideways or z-fights where the
  // carried-through piece meets the edge's own.
  const bands = [
    { inner: w => w/2 - 0.28, outer: w => w/2 + 0.05, y: 0.045, color: colors.edge },
  ];
  if (sidewalk) {
    bands.push({
      inner: w => w/2 + 0.05,
      outer: w => w/2 + 0.05 + sidewalk.width,
      y: sidewalk.height,
      color: sidewalk.color,
    });
  }

  for (const node of nodeById.values()) {
    const incident = edges.filter(e => e.from === node.id || e.to === node.id);
    for (const m of buildIntersectionPad(node, incident, colors)) group.add(m);
    // After the pad, so the markings draw over the pad's overhang rather
    // than the other way round.
    for (const m of buildCornerFills(node, incident, bands)) group.add(m);
  }

  const SAMPLES = allCenters.length;
  const normalAt = i => new THREE.Vector3(-allTangents[i].z, 0, allTangents[i].x);

  // Spawn point: an authored edge + fraction along it, not a curvature
  // search like the loop's straightestIdx() -- a graph's "straightest run"
  // isn't a meaningful single answer, and every edge here is straight by
  // construction anyway, so the author just picks one.
  let startIdx = 0;
  if (spec.startEdge) {
    const edge = edges.find(e => e.id === spec.startEdge.id);
    if (!edge) throw new Error(`startEdge "${spec.startEdge.id}" not found`);
    const t = spec.startEdge.t ?? 0.5;
    startIdx = edge.globalOffset + Math.round(t * (edge.SAMPLES - 1));
  }

  return {
    group,
    // Flattened compatibility view: a concatenation of every edge's own
    // samples in authoring order, NOT a physically continuous path -- two
    // consecutive global indices can belong to unrelated edges on opposite
    // sides of the map. That's fine for what still reads it in v1
    // (buildScenery/buildFeatures index centers/tangents/normalAt at a
    // single position at a time; car.js's nearestIdx does a local search
    // that's approximate here and is not used to gate resets on this world
    // -- see the dragOnOffTrack world-spec flag in sim/world.js/car.js).
    // It is NOT safe to assume index i+1 continues from index i.
    SAMPLES, width, startIdx, centers: allCenters, tangents: allTangents, normalAt,
    graph: { nodes: [...nodeById.values()], edges },
  };
}
