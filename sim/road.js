import * as THREE from 'three';

// ---------- road builder ----------
// A road is a closed Catmull-Rom spline sampled into centers/tangents,
// plus the meshes that draw it. Everything here is pure: buildRoad()
// constructs and returns, and never touches the scene or any module-level
// state -- sim/world.js decides what's live and when to tear it down.
// That's the whole reason this is a builder and not, as it used to be, a
// module that added itself to the scene on import.

const DEFAULT_SAMPLES = 900;

export const DEFAULT_COLORS = {
  asphalt: 0x3d4149,
  edge: 0xf3efe8,
  center: 0xffd23f,
  checkerLight: 0xf3efe8,
  checkerDark: 0x20242e,
};

// Per-sample width taper, factored out of buildRoad() so sim/roadgraph.js can
// build the same corner-radius protection for an open graph edge. `closed`
// picks how neighbour samples wrap: circularly for a loop, clamped at the two
// ends for an edge (which has no "before the start" or "after the end").
export function buildWidthScale(centers, tangents, SAMPLES, closed, maxOffset) {
  const widthScale = new Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    const p = closed ? (i - 1 + SAMPLES) % SAMPLES : Math.max(0, i - 1);
    const n2 = closed ? (i + 1) % SAMPLES : Math.min(SAMPLES - 1, i + 1);
    if (p === n2) { widthScale[i] = 1; continue; }
    const dTheta = tangents[p].angleTo(tangents[n2]);
    const ds = centers[p].distanceTo(centers[n2]);
    const radius = dTheta > 1e-6 ? ds / dTheta : Infinity;
    widthScale[i] = Math.min(1, (radius * 0.85) / maxOffset);
  }
  return widthScale;
}

// A flat offset ribbon along a sampled path -- the asphalt, the white edges,
// the sidewalk strips. `closed` controls whether the last vertex wraps back
// to the first (a loop) or the strip just ends (an open graph edge); the
// vertex/quad counts below are the only place that distinction shows up, the
// per-sample math is identical either way.
export function buildRibbon(centers, normalAt, widthScale, SAMPLES, closed, halfInner, halfOuter, y, color) {
  const pos = [], idx = [];
  const vertCount = closed ? SAMPLES + 1 : SAMPLES;
  for (let i = 0; i < vertCount; i++) {
    const j = i % SAMPLES, c = centers[j], n = normalAt(j), s = widthScale[j];
    pos.push(c.x + n.x*halfOuter*s, y, c.z + n.z*halfOuter*s,
             c.x + n.x*halfInner*s, y, c.z + n.z*halfInner*s);
  }
  const quadCount = closed ? SAMPLES : SAMPLES - 1;
  for (let i = 0; i < quadCount; i++) {
    const a = i*2, b = a+1, c2 = a+2, d = a+3;
    idx.push(a,b,c2, b,d,c2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  // See buildRoad()'s ribbon() for why DoubleSide: the strip's winding faces
  // down relative to every camera this sim uses.
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({color, side: THREE.DoubleSide}));
  m.receiveShadow = true;
  return m;
}

export const DASH_PITCH_M = 4.5;   // centre-to-centre along the road
export const DASH_LEN_M = 1.6;
const DASH_W = 0.22;

// Dashed centerline, instanced flat planes laid flat and aimed along the
// road (same "lay flat, then aim along the tangent" quaternion as the
// checker strip below). Shared between the loop and graph edges.
//
// Spacing is metric, walked along real arc length, rather than "every Nth
// sample" as it used to be. Sample spacing is not a fixed number of metres:
// it depends on the world's loop length, and within one loop it varies with
// how the spline parameterises its corners -- so a fixed sample stride gave
// a different dash pitch on every world and a visibly uneven one inside any
// single road.
//
// startClear/endClear are metres of road to leave bare at each end, and are
// what keep dashes out of an intersection. A graph edge stops exactly on
// the pad boundary, so a dash centred on its last sample used to hang half
// its length into the junction and paint straight over the crosswalk; the
// caller passes enough clearance to sit the first dash beyond both. The
// clearances are measured to the dash's END, not its centre -- half a dash
// length is added here, so callers state the gap they actually want to see.
export function buildDashedCenterline(centers, tangents, SAMPLES, color, opts = {}) {
  const {
    closed = true,
    pitch = DASH_PITCH_M,
    length = DASH_LEN_M,
    startClear = 0,
    endClear = 0,
  } = opts;

  const segs = closed ? SAMPLES : SAMPLES - 1;
  const arc = new Float64Array(segs + 1);
  for (let i = 0; i < segs; i++) {
    arc[i + 1] = arc[i] + centers[i].distanceTo(centers[(i + 1) % SAMPLES]);
  }
  const total = arc[segs];

  const first = startClear + length / 2;
  const last = total - endClear - length / 2;
  // A short edge between two junctions can be all clearance and no room to
  // paint. That's a legitimate layout, not an error -- draw nothing.
  if (last < first) return null;

  // A closed loop divides its pitch evenly into the lap instead of taking
  // the requested pitch literally: walking a fixed stride around a loop
  // leaves a ragged joint where the last dash meets the first, which is
  // exactly the seam a driver stares at on the start/finish straight.
  let count, step, base;
  if (closed) {
    count = Math.max(1, Math.round(total / pitch));
    step = total / count;
    base = first;
  } else {
    count = Math.floor((last - first) / pitch) + 1;
    step = pitch;
    base = first;
  }

  const dashes = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(DASH_W, length),
    new THREE.MeshBasicMaterial({ color }),
    count,
  );
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3();
  const ALONG = new THREE.Vector3(0, 0, 1), ONE = new THREE.Vector3(1, 1, 1);
  const FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

  let seg = 0, k = 0;
  for (let n = 0; n < count; n++) {
    const d = base + n * step;
    while (seg < segs - 1 && arc[seg + 1] < d) seg++;
    // Interpolated between samples rather than snapped to the nearest one:
    // at a 4.5m pitch on ~0.5m samples, snapping would quantise the gaps
    // into a visible stutter.
    const span = arc[seg + 1] - arc[seg];
    p.lerpVectors(centers[seg], centers[(seg + 1) % SAMPLES],
                  span > 1e-9 ? (d - arc[seg]) / span : 0);
    q.setFromUnitVectors(ALONG, tangents[seg]).multiply(FLAT);
    M.compose(new THREE.Vector3(p.x, 0.05, p.z), q, ONE);
    dashes.setMatrixAt(k++, M);
  }
  dashes.count = k;
  return dashes;
}

// Picks the straightest run on the loop for the start/finish line. Worlds
// may override with an explicit startIdx, but nothing about a spline's
// t=0 control point makes it a sensible place to line up -- it's just
// wherever the author happened to start typing coordinates, which can
// easily be mid-corner. Scores each sample by how much the road turns
// over a window roughly one car-length long and takes the flattest.
function straightestIdx(tangents, SAMPLES) {
  const HALF = Math.max(2, Math.round(SAMPLES / 75));
  const turn = new Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    turn[i] = tangents[i].angleTo(tangents[(i + 1) % SAMPLES]);
  }
  let best = 0, bestScore = Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    let s = 0;
    for (let o = -HALF; o <= HALF; o++) s += turn[(i + o + SAMPLES) % SAMPLES];
    if (s < bestScore) { bestScore = s; best = i; }
  }
  return best;
}

export function buildRoad(spec) {
  const width = spec.width ?? 7;
  const SAMPLES = spec.samples ?? DEFAULT_SAMPLES;
  const colors = { ...DEFAULT_COLORS, ...(spec.colors || {}) };

  const ctrl = spec.ctrl.map(p => new THREE.Vector3(p[0], 0, p[1]));
  const spline = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal');

  const centers = [], tangents = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = i / SAMPLES;
    centers.push(spline.getPoint(t));
    tangents.push(spline.getTangent(t).normalize());
  }
  const normalAt = i => new THREE.Vector3(-tangents[i].z, 0, tangents[i].x);
  const startIdx = spec.startIdx ?? straightestIdx(tangents, SAMPLES);

  // Per-sample width taper: at tight corners the curvature radius can be
  // smaller than the road half-width, which would make the offset ribbon
  // edges fold back across themselves (self-intersecting geometry). Scale
  // the lateral offset down wherever the local radius gets tight so the
  // ribbon never crosses its own centerline.
  //
  // Measured against the OUTERMOST ribbon, not the road edge: a sidewalk
  // sits further out than the asphalt does, so taking the road's own
  // half-width here would let the kerb fold on corners the road itself
  // survives.
  const sidewalk = spec.sidewalk ? { width: 2.4, height: 0.14, color: 0x8d8f8a, ...spec.sidewalk } : null;
  const MAX_OFFSET = width / 2 + 0.05 + (sidewalk ? sidewalk.width : 0);
  const widthScale = buildWidthScale(centers, tangents, SAMPLES, true, MAX_OFFSET);

  const group = new THREE.Group();

  // road ribbon -- the strip's triangle winding faces downward everywhere (a
  // quirk of how the outer/inner offsets are ordered relative to the loop's
  // traversal direction), which put it on the back face relative to every
  // camera we use (all of them sit above the road); buildRibbon's DoubleSide
  // material keeps it visible regardless of winding.
  const ribbon = (halfInner, halfOuter, y, color) =>
    buildRibbon(centers, normalAt, widthScale, SAMPLES, true, halfInner, halfOuter, y, color);
  group.add(ribbon(-width/2, width/2, 0.02, colors.asphalt));            // asphalt
  group.add(ribbon( width/2-0.28,  width/2+0.05, 0.045, colors.edge));   // white edges
  group.add(ribbon(-width/2-0.05, -width/2+0.28, 0.045, colors.edge));

  // Raised kerbs either side, for worlds that want a street rather than a
  // road. Flat ribbons at a height, not extruded kerbs: from the POV
  // camera's eye line the step reads fine, and it keeps this to two more
  // strips of the geometry that already works.
  if (sidewalk) {
    const inner = width/2 + 0.05, outer = inner + sidewalk.width;
    group.add(ribbon(inner, outer, sidewalk.height, sidewalk.color));
    group.add(ribbon(-outer, -inner, sidewalk.height, sidewalk.color));
  }

  // Closed: a loop has no ends to keep clear of, and the pitch divides the
  // lap evenly so the dashes meet cleanly where it closes.
  const dashes = buildDashedCenterline(centers, tangents, SAMPLES, colors.center);
  if (dashes) group.add(dashes);

  // start / finish checker strip, built from small flat-colored cells (like
  // the dashes above) instead of vertex-colored quads: vertex colors are
  // interpolated across shared vertices, which turns a checker pattern into
  // a soft gradient instead of crisp squares. Reuses the dashes' quaternion
  // "lay flat, then aim along the tangent" transform too -- composing
  // rotation.x and rotation.z as separate Euler angles doesn't spin the
  // strip around the vertical axis the way it looks like it should; with Y
  // up, that needs rotation.y, and mixing x+z Euler rotations instead tips
  // the whole strip out of the ground plane.
  {
    const CELLS_X = 8, CELLS_Y = 2;
    const cellW = width / CELLS_X, cellL = 1.4 / CELLS_Y;
    const cellGeo = new THREE.PlaneGeometry(cellW * 0.98, cellL * 0.98);
    const matLight = new THREE.MeshBasicMaterial({color: colors.checkerLight});
    const matDark  = new THREE.MeshBasicMaterial({color: colors.checkerDark});
    const cellCount = Math.ceil(CELLS_X * CELLS_Y / 2) + 1;
    const light = new THREE.InstancedMesh(cellGeo, matLight, cellCount);
    const dark  = new THREE.InstancedMesh(cellGeo, matDark, cellCount);
    const c0 = centers[startIdx], t0 = tangents[startIdx];
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1), t0)
                .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), -Math.PI/2));
    const M = new THREE.Matrix4();
    let kL = 0, kD = 0;
    for (let cx = 0; cx < CELLS_X; cx++) {
      for (let cy = 0; cy < CELLS_Y; cy++) {
        const local = new THREE.Vector3((cx - (CELLS_X-1)/2) * cellW, (cy - (CELLS_Y-1)/2) * cellL, 0).applyQuaternion(q);
        M.compose(new THREE.Vector3(c0.x + local.x, 0.055 + local.y, c0.z + local.z), q, new THREE.Vector3(1,1,1));
        if ((cx + cy) % 2) light.setMatrixAt(kL++, M); else dark.setMatrixAt(kD++, M);
      }
    }
    light.count = kL; dark.count = kD;
    group.add(light, dark);
  }

  return { group, SAMPLES, width, startIdx, centers, tangents, normalAt };
}
