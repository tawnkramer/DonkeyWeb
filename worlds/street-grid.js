// A branching street layout, in place of the other worlds' single loop.
//
// Shape: one inner block with a 4-way at each of its corners, four radial
// streets running out from those corners to a perimeter ring road, and a
// T intersection wherever a radial meets the ring. The ring closes, so no
// street ends abruptly anywhere -- every drivable surface leads somewhere,
// which also means a lap is always possible however you turn.
//
//        P---T---T---P        P  ring corner (90deg bend, no junction)
//        |   |   |   |        T  T intersection (ring x radial)
//        T---A---C---T        A  signalised 4-way
//        |   |   |   |        B  stop-sign 4-way
//        T---B---D---T        C,D  uncontrolled 4-ways
//        |   |   |   |
//        P---T---T---P
//
// v1 on purpose: no roundabout, no recovery-data generation, no autopilot
// lap support. Signals and stop signs are added in later milestones as
// `features` entries once sim/intersectionSignals.js and sim/stopsign.js
// exist -- the `type` on each node below is what they will key off, and is
// carried now so the layout doesn't have to be re-authored later.
const BLOCK = 22.5;   // inner corners sit at +-BLOCK
const RING  = 50;     // perimeter runs at +-RING
const ROAD_W = 7;

// A junction's pad has to overhang the kerb by at least the kerb radius,
// because that overhang is the bare corner the rounded kerb return is drawn
// into -- see buildKerbReturn in sim/roadgraph.js, which caps the radius at
// whatever the pad actually leaves room for. Derived rather than typed in,
// so a pad edit can't quietly flatten the corners back to square.
//
// A 90deg bend has no corner to round and must instead be sized to the road
// exactly, or it bulges past the kerb -- see buildIntersectionPad.
const KERB_R = 2.4;
const SIDEWALK_W = 2.6;
const JUNCTION_PAD = ROAD_W + 2 * (KERB_R + 0.15);
const BEND_PAD = ROAD_W;

const junction = (id, x, z, type) => ({ id, pos: [x, z], type, pad: JUNCTION_PAD });
const bend = (id, x, z) => ({ id, pos: [x, z], type: 'plain', pad: BEND_PAD });
// Ids are derived from the endpoints rather than hand-numbered: they stay
// readable in an error message ("edge T_n_w>A is only 0.3m after pad trim")
// and can't silently drift out of sync with the nodes they join.
const edge = (from, to) => ({ id: `${from}>${to}`, from, to });

export default {
  id: 'street-grid',
  name: 'street grid',
  blurb: 'branching streets, junctions, ring road',

  width: ROAD_W,
  colors: { asphalt: 0x43474e, center: 0xe8c53f, edge: 0xdfdcd4 },
  sidewalk: { width: SIDEWALK_W, height: 0.15, color: 0x8f918b },

  graph: {
    nodes: [
      // Inner block corners -- the 4-ways.
      junction('A', -BLOCK,  BLOCK, 'signal'),
      junction('B', -BLOCK, -BLOCK, 'stop'),
      junction('C',  BLOCK,  BLOCK, 'plain'),
      junction('D',  BLOCK, -BLOCK, 'plain'),

      // Where each radial meets the ring: a side street joining a through
      // road, so these are stop-controlled on the radial approach. Which
      // approaches actually get a sign is M3's call; the node type just
      // says what kind of junction this is.
      junction('T_n_w', -BLOCK,  RING, 'stop'),
      junction('T_n_e',  BLOCK,  RING, 'stop'),
      junction('T_s_w', -BLOCK, -RING, 'stop'),
      junction('T_s_e',  BLOCK, -RING, 'stop'),
      junction('T_w_n', -RING,   BLOCK, 'stop'),
      junction('T_w_s', -RING,  -BLOCK, 'stop'),
      junction('T_e_n',  RING,   BLOCK, 'stop'),
      junction('T_e_s',  RING,  -BLOCK, 'stop'),

      // Ring corners -- bends, not junctions.
      bend('P_nw', -RING,  RING),
      bend('P_ne',  RING,  RING),
      bend('P_sw', -RING, -RING),
      bend('P_se',  RING, -RING),
    ],
    edges: [
      // Inner block perimeter.
      edge('A', 'C'), edge('A', 'B'), edge('C', 'D'), edge('B', 'D'),

      // Radials, authored ring -> inner block, so driving forward from a
      // spawn on one of these heads into the block.
      edge('T_n_w', 'A'), edge('T_n_e', 'C'),
      edge('T_s_w', 'B'), edge('T_s_e', 'D'),
      edge('T_w_n', 'A'), edge('T_w_s', 'B'),
      edge('T_e_n', 'C'), edge('T_e_s', 'D'),

      // The ring itself, corner -> T -> T -> corner on each side.
      edge('P_nw', 'T_n_w'), edge('T_n_w', 'T_n_e'), edge('T_n_e', 'P_ne'),
      edge('P_ne', 'T_e_n'), edge('T_e_n', 'T_e_s'), edge('T_e_s', 'P_se'),
      edge('P_se', 'T_s_e'), edge('T_s_e', 'T_s_w'), edge('T_s_w', 'P_sw'),
      edge('P_sw', 'T_w_s'), edge('T_w_s', 'T_w_n'), edge('T_w_n', 'P_nw'),
    ],
  },
  // Spawn on the northern radial heading into the block, far enough back
  // that the signalised junction at A is ahead and in frame.
  startEdge: { id: 'T_n_w>A', t: 0.3, laneOffset: ROAD_W / 4 },

  // Graph worlds don't have a single intended line -- see sim/world.js's
  // road.dragOnOffTrack for why the loop worlds' off-track deceleration
  // would misfire here. reset:'collision' still applies: hitting a
  // building ends the run and rewinds, exactly like the city loop.
  reset: 'collision',
  dragOnOffTrack: false,

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
    // Shallower and set closer than the city loop's frontages. The strip
    // between a radial and the ring is only ~27m wide, and the loop's
    // 7.5m setback with 13m of depth reaches most of the way across it --
    // every one of those plots would be thrown out by the roadway check
    // in sim/scenery.js and the block would come out bare. Low-rise, so
    // the streets still get light (the same reason the city loop capped
    // its heights).
    buildings: {
      setback: 5, minAcross: 5, maxAcross: 8,
      minAlong: 8, maxAlong: 13,
      minH: 6, maxH: 18, spacing: 30, density: 0.7,
    },
    streetlights: {},
  },

  features: [
    {
      type: 'intersectionSignals',
      allIntersections: true,
      cycle: { green: 9, yellow: 2.5, allRed: 1 },
    },
    {
      type: 'traffic',
      speed: 5.5,
      bots: [
        { id: 'ring-1', route: ['P_nw','T_n_w','T_n_e','P_ne','T_e_n','T_e_s','P_se','T_s_e','T_s_w','P_sw','T_w_s','T_w_n'], start: 0.03, color: 0xd85b45 },
        { id: 'ring-2', route: ['P_ne','T_n_e','T_n_w','P_nw','T_w_n','T_w_s','P_sw','T_s_w','T_s_e','P_se','T_e_s','T_e_n'], start: 0.48, color: 0x46a36f },
        { id: 'block-1', route: ['A','C','D','B'], start: 0.12, color: 0xd3a936 },
        { id: 'block-2', route: ['A','B','D','C'], start: 0.62, color: 0x8d65bd },
        { id: 'block-3', route: ['A','C','D','B'], start: 0.45, color: 0x4b86c6 },
        { id: 'block-4', route: ['A','B','D','C'], start: 0.95, color: 0xd9779f },
        { id: 'block-5', route: ['A','C','D','B'], start: 0.78, color: 0x63a64d },
        { id: 'block-6', route: ['A','B','D','C'], start: 0.29, color: 0xd47c35 },
      ],
    },
  ],
};
