// The original track: a long, flowing dusk loop. Default world.
export default {
  id: 'dusk-loop',
  name: 'dusk loop',
  blurb: 'long flowing corners, golden-hour light',

  // The start/finish point [0,0] originally sat between [18,-30] and [34,-6],
  // a raw ~130° hairpin -- tighter than the road's own half-width (self-
  // intersecting) and noticeably tighter than every other corner on the loop
  // (which range ~10-25m radius). [10.4,5.2] and [-3.7,-10.3] are eased
  // chamfer points, and the two original neighbors were nudged outward
  // ([18,-30]->[0,-30], [34,-6]->[43,-3]) so the whole start/finish area
  // turns at roughly the same comfortable radius (~9m) as the rest of the
  // track instead of reading as an outlier hairpin.
  ctrl: [
    [  0,    0], [ 10.4,  5.2], [ 43,  -3], [ 58,   8], [ 66,  36], [ 46,  56],
    [ 14,   50], [ -6,   66], [-40,  62], [-58,  34], [-50,   4],
    [-64,  -26], [-42,  -50], [ -8, -46], [  0, -30], [-3.7, -10.3]
  ],
  width: 7,
  // Pinned rather than auto-picked: this is the index the original track
  // shipped with, and moving the line would silently invalidate the
  // start-pose distribution of every dataset recorded before now.
  startIdx: 420,

  env: {
    sky: [[0, '#8ea0d8'], [0.55, '#c3a7c9'], [1, '#f2b98e']],
    fog: { color: 0xf2b98e, near: 60, far: 240 },
    ground: 0x8fae7e,
    hemi: { sky: 0xbcc7ff, ground: 0xd8a06a, intensity: 0.85 },
    sun: { color: 0xffe3c0, intensity: 1.0, position: [-60, 80, 30] },
  },

  scenery: {},

  // Stop signs, traffic lights, and passenger stops will be declared here.
  features: [],
};
