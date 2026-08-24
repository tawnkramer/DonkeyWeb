// A city street loop under overcast light.
//
// Single path, no junctions. That is a deliberate limit, not an
// oversight: the road is one closed spline and car.js/recovery.js index
// into it circularly, so branching needs a road-graph refactor first. It
// also needs the model to grow a route-command input, because at a real
// junction identical pixels map to left, straight AND right, and an MSE
// regression averages those into "go straight".
//
// What DOES work here is the traffic light: its state is visible in the
// frame, so stopping on red is a function of the current image and the
// existing single-frame model can learn it.
export default {
  id: 'city',
  name: 'city-loop',
  blurb: 'street loop, signals, overcast',

  // A rounded block loop: long straights so signals are visible from a
  // distance, corners gentle enough that the building frontages either
  // side stay clear of the kerb.
  ctrl: [
    [ 62, -42], [ 72,  -4], [ 62,  38], [ 30,  58], [ -8,  62],
    [-44,  50], [-70,  18], [-72, -20], [-52, -50], [-16, -62], [ 24, -58]
  ],
  width: 8,
  colors: { asphalt: 0x43474e, center: 0xe8c53f, edge: 0xdfdcd4 },
  sidewalk: { width: 2.6, height: 0.15, color: 0x8f918b },

  // Fail on contact, not on cross-track error. The other worlds put you
  // back on the centreline the moment you stray half a road-width from
  // it, which is the right rule on a race circuit and the wrong one on a
  // street: here the roadway is somewhere to move around in -- pulling
  // wide, stopping at a bar short of the line -- and the thing that
  // actually ends a run is hitting a building. car.js rewinds three
  // seconds instead of snapping to the centreline, because a city street
  // has no single correct line to snap back to.
  reset: 'collision',

  env: {
    sky: [[0, '#7f93ad'], [0.55, '#9fb0c4'], [1, '#c6cfd8']],
    fog: { color: 0xc6cfd8, near: 70, far: 260 },
    ground: 0x7a7d72,
    hemi: { sky: 0xc8d6e8, ground: 0x6a6f66, intensity: 0.72 },
    sun: { color: 0xfff2e0, intensity: 0.95, position: [-50, 90, 40] },
  },

  scenery: {
    cones: false,
    trees: false,
    // Set well back off the kerb and kept low-rise. Tight setbacks with
    // tall towers turned the street into a slot canyon that the sun never
    // reached, and the POV frame -- the thing the model actually trains
    // on -- came out nearly black.
    buildings: { setback: 7.5, minH: 6, maxH: 20, spacing: 30, maxAlong: 13 },
    streetlights: {},
  },

  features: [
    {
      type: 'trafficLights',
      // Spread around the loop and deliberately out of phase with each
      // other, so a lap meets lights in every state rather than a
      // synchronised green wave that never teaches stopping.
      at: [70, 280, 500, 730],
      cycle: { green: 9, yellow: 2.5, red: 7 },
      phase: [0, 5.5, 11, 15.5],
    },
  ],
};
