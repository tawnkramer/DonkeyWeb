// Tight, narrow desert road -- the hard world. Small radii and a 5m road
// mean the off-track threshold is only 2.6m from the centerline, so it
// punishes exactly the lag that behavior-cloned models show on corner
// entry. Deliberately the opposite end of the difficulty range from
// speedway.
export default {
  id: 'canyon',
  name: 'canyon',
  blurb: 'narrow, tight turns, low sun',

  // Control points advance monotonically around the origin by angle, with
  // the radius swinging between ~30m and ~48m to make the corners. Keeping
  // the angle monotone is what stops the spline from doubling back on
  // itself into a hairpin tighter than the car's own 2.7m turning circle
  // (the failure the original dusk-loop track hit at its start/finish).
  ctrl: [
    [ 30,  -2], [ 34,  20], [ 14,  30], [ -2,  46], [-24,  42], [-26,  20],
    [-44,   6], [-40, -16], [-22, -22], [-16, -40], [  8, -38], [ 26, -24]
  ],
  width: 5,
  colors: { asphalt: 0x46433c, center: 0xf0c24a },

  env: {
    sky: [[0, '#c46a3a'], [0.5, '#e0a05c'], [1, '#f6d9a8']],
    fog: { color: 0xe8c295, near: 40, far: 180 },
    ground: 0x9c6b46,
    // Both lights are warm here, so the red/green channels saturate first
    // and everything drifts orange -- the asphalt in particular stopped
    // reading as asphalt. Low intensities keep the road dark against the
    // sand instead.
    hemi: { sky: 0xffd9a8, ground: 0x8a5a38, intensity: 0.5 },
    sun: { color: 0xffcf9a, intensity: 0.8, position: [70, 60, 40] },
  },

  scenery: {
    cones: { color: 0xe8532b, offset: 0.55 },
    // Desert scrub rather than trees: same builder, shorter and drier.
    trees: {
      count: 55, seed: 13, trunk: 0x8a6b4a, leaf: 0x6b7a4a,
      ringMin: 14, ringSpan: 110, clearance: 10,
      trunkH: 0.9, leafR: 1.1, leafH: 2.0,
    },
  },

  features: [],
};
