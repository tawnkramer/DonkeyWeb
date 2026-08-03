// ---------- collision ----------
// Worlds that reset on contact rather than on cross-track error need to
// know what's solid. Colliders are flat 2D shapes in the ground plane --
// height is irrelevant when nothing in this sim can drive over or under
// anything -- and the car is tested as a circle rather than its true
// 0.9x1.7 rectangle: at these speeds the difference is smaller than the
// margin you'd want anyway, and it keeps the test to a handful of
// arithmetic ops per obstacle.
//
// There is no spatial index. A city block is on the order of 100
// obstacles, tested once per 50Hz physics tick, which is a few thousand
// distance checks a second -- far below the cost of a single frame's
// rendering. Add a grid here if a world ever gets dense enough to matter.

export const CAR_RADIUS = 0.7;

// An upright box, e.g. a building: centre, half-extents, and the yaw its
// long axis is rotated to.
export function boxCollider(x, z, halfX, halfZ, yaw) {
  return { kind: 'box', x, z, halfX, halfZ, sin: Math.sin(yaw), cos: Math.cos(yaw) };
}

// A post: traffic light masts, streetlight poles, tree trunks.
export function circleCollider(x, z, r) {
  return { kind: 'circle', x, z, r };
}

function hitsBox(c, x, z, r) {
  // Into the box's own frame, then the standard "closest point on the box
  // to the circle centre" test.
  const dx = x - c.x, dz = z - c.z;
  const lx =  dx * c.cos - dz * c.sin;
  const lz =  dx * c.sin + dz * c.cos;
  const cx = Math.max(-c.halfX, Math.min(c.halfX, lx));
  const cz = Math.max(-c.halfZ, Math.min(c.halfZ, lz));
  const ex = lx - cx, ez = lz - cz;
  return ex * ex + ez * ez < r * r;
}

function hitsCircle(c, x, z, r) {
  const dx = x - c.x, dz = z - c.z;
  const rr = c.r + r;
  return dx * dx + dz * dz < rr * rr;
}

// Returns the first collider hit, or null. Returning the collider rather
// than a boolean so callers can report what was struck.
export function hitTest(list, x, z, r = CAR_RADIUS) {
  for (const c of list) {
    if (c.kind === 'box' ? hitsBox(c, x, z, r) : hitsCircle(c, x, z, r)) return c;
  }
  return null;
}
