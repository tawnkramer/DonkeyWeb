// A wide, fast oval under midday sun -- the easy world. Gentle curvature
// everywhere means almost no cones (they're placed by corner tightness),
// long straights, and steering targets that sit near zero most of the lap.
// Useful as a sanity baseline: a model that can't clone this one has a
// problem that isn't the track.
export default {
  id: 'speedway',
  name: 'speedway',
  blurb: 'wide fast oval, midday sun',

  ctrl: [
    [  0, -58], [ 46, -52], [ 78, -28], [ 86,   4], [ 74,  38], [ 40,  58],
    [ -4,  62], [-46,  54], [-78,  30], [-88,  -4], [-76, -34], [-40, -56]
  ],
  width: 9,

  env: {
    sky: [[0, '#4f86d6'], [0.6, '#8fbbe8'], [1, '#d8e6f2']],
    fog: { color: 0xd8e6f2, near: 90, far: 320 },
    ground: 0x7d9c62,
    // Kept well under dusk-loop's 0.85/1.0: this world's sun and hemi are
    // both near-white, and at those intensities the Lambert ground clipped
    // past 1.0 and washed out to cream instead of reading as grass.
    hemi: { sky: 0xcfe2ff, ground: 0x8f9a6a, intensity: 0.55 },
    sun: { color: 0xfffaf0, intensity: 0.9, position: [40, 120, -20] },
  },

  scenery: {
    trees: { count: 70, seed: 21, ringMin: 34, ringSpan: 190, clearance: 18 },
  },

  features: [],
};
