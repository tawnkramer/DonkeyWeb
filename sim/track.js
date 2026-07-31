import * as THREE from 'three';
import { scene } from './scene.js';

// ---------- track (closed Catmull-Rom spline) ----------
export const TRACK_W = 7;                 // road width (m)
// The start/finish point [0,0] originally sat between [18,-30] and [34,-6],
// a raw ~130° hairpin -- tighter than the road's own half-width (self-
// intersecting) and noticeably tighter than every other corner on the loop
// (which range ~10-25m radius). [10.4,5.2] and [-3.7,-10.3] are eased
// chamfer points, and the two original neighbors were nudged outward
// ([18,-30]->[0,-30], [34,-6]->[43,-3]) so the whole start/finish area
// turns at roughly the same comfortable radius (~9m) as the rest of the
// track instead of reading as an outlier hairpin.
const ctrl = [
  [  0,    0], [ 10.4,  5.2], [ 43,  -3], [ 58,   8], [ 66,  36], [ 46,  56],
  [ 14,   50], [ -6,   66], [-40,  62], [-58,  34], [-50,   4],
  [-64,  -26], [-42,  -50], [ -8, -46], [  0, -30], [-3.7, -10.3]
].map(p => new THREE.Vector3(p[0], 0, p[1]));
const spline = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal');

export const SAMPLES = 900;
export const centers = [], tangents = [];
for (let i = 0; i < SAMPLES; i++) {
  const t = i / SAMPLES;
  centers.push(spline.getPoint(t));
  tangents.push(spline.getTangent(t).normalize());
}
export const normalAt = i => new THREE.Vector3(-tangents[i].z, 0, tangents[i].x);

// Start/finish sits on the straightest run on the loop (~12m of gentle
// curvature around sample 420, near [-22,67]) rather than at the spline's
// t=0 control point -- which is the eased corner from the hairpin fix and
// isn't where a start/finish line normally goes.
export const START_IDX = 420;

// Per-sample width taper: at tight corners the curvature radius can be
// smaller than the road half-width, which would make the offset ribbon
// edges fold back across themselves (self-intersecting geometry). Scale
// the lateral offset down wherever the local radius gets tight so the
// ribbon never crosses its own centerline.
const MAX_OFFSET = TRACK_W/2 + 0.05;
const widthScale = new Array(SAMPLES);
for (let i = 0; i < SAMPLES; i++) {
  const p = (i - 1 + SAMPLES) % SAMPLES, n2 = (i + 1) % SAMPLES;
  const dTheta = tangents[p].angleTo(tangents[n2]);
  const ds = centers[p].distanceTo(centers[n2]);
  const radius = dTheta > 1e-6 ? ds / dTheta : Infinity;
  widthScale[i] = Math.min(1, (radius * 0.85) / MAX_OFFSET);
}

// road ribbon
function ribbon(halfInner, halfOuter, y, color) {
  const pos = [], idx = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const j = i % SAMPLES, c = centers[j], n = normalAt(j), s = widthScale[j];
    pos.push(c.x + n.x*halfOuter*s, y, c.z + n.z*halfOuter*s,
             c.x + n.x*halfInner*s, y, c.z + n.z*halfInner*s);
  }
  for (let i = 0; i < SAMPLES; i++) {
    const a = i*2, b = a+1, c2 = a+2, d = a+3;
    idx.push(a,b,c2, b,d,c2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  // The strip's triangle winding faces downward everywhere (a quirk of how
  // the outer/inner offsets are ordered relative to the loop's traversal
  // direction), which put it on the back face relative to every camera we
  // use (all of them sit above the road). DoubleSide keeps it visible
  // regardless of winding.
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({color, side: THREE.DoubleSide}));
  m.receiveShadow = true;
  return m;
}
scene.add(ribbon(-TRACK_W/2, TRACK_W/2, 0.02, 0x3d4149));            // asphalt
scene.add(ribbon( TRACK_W/2-0.28,  TRACK_W/2+0.05, 0.045, 0xf3efe8)); // white edges
scene.add(ribbon(-TRACK_W/2-0.05, -TRACK_W/2+0.28, 0.045, 0xf3efe8));

// dashed yellow center line
{
  const dashGeo = new THREE.PlaneGeometry(0.22, 1.6);
  const dashMat = new THREE.MeshBasicMaterial({color:0xffd23f});
  const STEP = 8;
  const dashes = new THREE.InstancedMesh(dashGeo, dashMat, Math.floor(SAMPLES/STEP/2)+1);
  const M = new THREE.Matrix4(), q = new THREE.Quaternion();
  let k = 0;
  for (let i = 0; i < SAMPLES; i += STEP*2) {
    const c = centers[i], tan = tangents[i];
    q.setFromUnitVectors(new THREE.Vector3(0,0,1), tan);
    M.compose(new THREE.Vector3(c.x, 0.05, c.z),
              q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), -Math.PI/2)),
              new THREE.Vector3(1,1,1));
    dashes.setMatrixAt(k++, M);
  }
  dashes.count = k;
  scene.add(dashes);
}

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
  const cellW = TRACK_W / CELLS_X, cellL = 1.4 / CELLS_Y;
  const cellGeo = new THREE.PlaneGeometry(cellW * 0.98, cellL * 0.98);
  const matLight = new THREE.MeshBasicMaterial({color:0xf3efe8});
  const matDark  = new THREE.MeshBasicMaterial({color:0x20242e});
  const cellCount = Math.ceil(CELLS_X * CELLS_Y / 2) + 1;
  const light = new THREE.InstancedMesh(cellGeo, matLight, cellCount);
  const dark  = new THREE.InstancedMesh(cellGeo, matDark, cellCount);
  const c0 = centers[START_IDX], t0 = tangents[START_IDX];
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
  scene.add(light, dark);
}
