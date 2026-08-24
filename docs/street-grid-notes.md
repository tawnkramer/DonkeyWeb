# The street-grid world — working notes

Status: **M2 in review** on branch `street-grid`, uncommitted.
The road graph, layout, road paint, graph-aware street lights and coordinated
signals at every junction are implemented. Bot traffic is **not started**.
The earlier stop-sign milestone is superseded by signalising every junction.
These are notes-to-self so the thread can be picked up cold, in
the same spirit as
`city-braking-notes.md`.

## Why this world exists

`worlds/city.js` is a single closed spline, and its header says why it has to
be: `car.js` and `recovery.js` index the road circularly, so branching needed
a road-graph refactor first. This world is that refactor plus a layout that
uses it — a real street network with junctions, so the sim can eventually
teach signals, stop signs and interaction with other traffic.

Three scope decisions were made up front and still hold:

1. **Small layout.** One block grid, not a whole city. No roundabout — that
   is its own geometry and its own AI problem.
2. **Bots will be scripted route-followers.** Fixed routes, obey signals and
   stop-sign dwell, brake for whatever is ahead on their own route. No
   right-of-way negotiation.
3. **Pathing is deferred.** Manual driving with collision reset only.
   `recovery.js`'s Stanley controller and autopilot laps stay loop-only.

## What is built

### The graph — `sim/roadgraph.js`

`buildRoadGraph(spec)` is a sibling of `buildRoad`, not a replacement. Loop
worlds still go through `buildRoad` unchanged. A world opts in by having
`spec.graph` instead of `spec.ctrl`; `sim/world.js` picks the builder on that
one field.

An edge is drawn exactly like a loop, just open. `buildRibbon`,
`buildWidthScale` and `buildDashedCenterline` were extracted out of
`sim/road.js` and take a `closed` flag — the wrap-vs-clamp of neighbour
samples is the only real difference. Edges are trimmed back to each end
node's pad boundary, which is what makes a junction look joined.

**The flattened array is the load-bearing compatibility hack.** `car.js`,
`recovery.js` and the generic world tests still want one
`centers`/`tangents`/`SAMPLES`, so the builder concatenates every edge's
samples in authoring order and gives each edge a `globalOffset`. That array
is **not a continuous path** — consecutive indices can be on opposite sides of
the map. Anything that assumes `i+1` continues from `i` is wrong on this
world. Two consequences already handled, both in `car.js`:

- `road.dragOnOffTrack` (false here) gates the off-track grass drag. On a
  graph the flattened centreline is bookkeeping, so turning onto a
  cross-street would otherwise brake the car for doing the intended thing.
- The no-rewind-history collision fallback goes to the authored spawn rather
  than `resetCar()`'s nearest sample, which could be across a branch never
  driven.

### The layout — `worlds/street-grid.js`

```
P---T---T---P     P  ring corner (90deg bend, degree 2)
|   |   |   |     T  T intersection (ring x radial, degree 3)
T---A---C---T     A  signalised 4-way    B  stop-sign 4-way
|   |   |   |     C,D  uncontrolled 4-ways
T---B---D---T
|   |   |   |     16 nodes, 24 edges, nothing dead-ends
P---T---T---P
```

Node `type` (`'signal'`, `'stop'`, `'plain'`) is **already authored and
currently unread** — it is what M2/M3 should key off, and it is carried now
so the layout does not need re-authoring.

Edge ids are derived from endpoints (`T_n_w>A`), so they stay readable in an
error and cannot drift out of sync with the nodes.

### Road paint

Three separate problems, worth keeping straight because they have different
fixes:

**Centreline.** Metric now, walked along real arc length, not every Nth
sample — sample spacing varies with loop length and with how a spline
parameterises corners, so a fixed stride gave a different pitch on every
world. `DASH_PITCH_M` 4.5, `DASH_LEN_M` 1.6. A closed loop divides the pitch
evenly into the lap so the dashes meet cleanly at the closure. Graph edges
take a clearance at each end (`DASH_CLEAR_JUNCTION` ≈ 2.95m covers pad +
crosswalk, `DASH_CLEAR_BEND` 0.6m covers pad alone), because an edge stops on
the pad boundary and a dash centred on its last sample hung into the junction
and painted over the crosswalk.

**Kerbside gaps wider than a right angle.** The white edge line and the
footway both stop at the pad. At the back of a T (180°) and the outside of a
bend (270°) that leaves a real strip missing. One construction covers both:
walk the two inner edges of a band to where they meet and the two outer edges
to where those meet; what lies between is the piece. When the approaches are
opposite, neither pair meets and it degenerates to a straight strip — which
is exactly right. `buildCornerFills` takes a list of *bands* (pairs of
lateral offsets as functions of edge width), and the edge line and footway
are just two bands through the same machinery.

**Junction corners (right angles).** Here the two sides already overlap, so
no strip is missing — what showed through was the pad's own overhang, as a
square bite of asphalt out of the corner of the footway. `buildKerbReturn`
replaces it with an arc tangent to both kerb lines, the roadway keeping the
rounded corner.

> Two traps, both hit once already:
> - **The radius is capped by the pad overhang.** Outside it the straight
>   ribbons have already painted a square corner and nothing additive can
>   remove paint. So `JUNCTION_PAD` is *derived* from `KERB_R` in the world
>   spec (`ROAD_W + 2*(KERB_R + 0.15)` = 12.1m) — editing the pad directly
>   would silently flatten the corners back to square.
> - **The piece must run to the pad boundary, not the tangent point.** The
>   radius is capped *below* what the pad leaves, so stopping at the tangent
>   leaves a ~0.1m sliver of pad showing where it hands off to the straight
>   ribbon. Visible as a thin dark L at each corner.

### Scenery — `sim/scenery.js`

Buildings were set back along each sample's normal, silently assuming there
is only ever one road to be set back from. True for a loop; false the moment
streets run tens of metres apart and cross — the first build came out a maze
of buildings standing in the road. Plots and posts are now rejection-tested
against the roadway with `onRoadway()`, using the **real footprint** rather
than the centre, since a building's centre can sit well clear while its
corner is mid-lane. Buildings get 1.2m clearance; posts get 0, because a lamp
post is meant to stand just off the kerb with its arm over the lane.

Street lights reuse the low-poly pole/arm/lamp construction from `city`.
Loop worlds retain their existing flattened-sample placement. Graph worlds
place them independently on each edge, with a half-spacing margin at both
ends, so the flattened compatibility array cannot put a post across an
unrelated edge or directly in a junction pad. The street-grid enables them
with the default scenery settings; their poles are included in the collision
list.

## Testing

- `test/roadgraph.test.js` — 20 tests, **plain `node:test`, no browser**.
  `sim/roadgraph.js` only touches three.js's pure math/geometry classes, so it
  imports and runs directly. This is the fast loop; use it.
- `test/street-grid.test.js` — 5 browser tests via `setupSimPage`.
- `test/world.test.js` — gained `no world puts a solid object on its own
  roadway`, asserted across **every** world, not just this one.

The paint tests read geometry **back out of the built scene** and measure it,
rather than restating the constants that drew it — `paintRects()` pulls
instanced markings by stripe width, `bandTriangles()` pulls corner pieces by
height and does point-in-triangle coverage. Prefer extending those over
asserting on constants.

**Every one of these was confirmed to fail without its fix** (stash the
change, watch it go red). Do the same for anything added — several of these
tests pass vacuously if written carelessly, because "is this point covered by
paint" is trivially satisfiable by the wrong mesh.

Watch for: `scripts/test.sh` has `set -e`, so one red file hides every file
after it alphabetically. And `test/stoprec.test.js` is a known flake — re-run
before investigating. Don't run `training.test.js` (>3 min) without asking.

## What's next

### M2 — coordinated signalised junctions — implemented

`sim/intersectionSignals.js` places one signal on every incoming edge of each
degree-3/4 junction (40 approaches across four 4-ways and eight Ts).
Placement is edge-local: the stop bar is measured back from the near side in
metres, while the mast sits beyond the far kerb and its arm reaches over the
incoming lane. This keeps the head visible through the intersection.

Each junction clock has named axis groups. North/south approaches share a
green window while east/west stays red, followed by yellow and an all-red
clearance interval; then east/west gets the corresponding window. Crossing
traffic can never be green together. The signal geometry constants now live
in `sim/signalparts.js`, shared by the loop and intersection builders.

The feature is registered as `intersectionSignals` and street-grid enables it
for all junctions. As with the loop traffic lights, signals are cosmetic and
do not enforce stopping.

Read the long comment at the top of `sim/trafficlight.js` before placing
anything. The signal head geometry is driven by the 160×120 POV frame, not by
realism: a correctly scaled head is a couple of pixels, and at a realistic
mount height it leaves the top of the frame as you reach the line — which
would make "stopped at red" and "stopped at green" identical pixels and
silently unlearnable. Reuse the stop-bar distance; re-verify with
`city.test.js`'s POV-frustum test pattern per approach.

### Superseded — stop signs

The original plan assigned stop signs to B and the eight Ts. The reviewed
direction is now one coordinated traffic signal for every incoming approach
at every junction, so those authored node types remain harmless metadata and
no stop-sign feature is planned.

### M4 — bot traffic

New `sim/traffic.js`. Two structural decisions matter more than they look:

- **Bots must step in the fixed 50 Hz loop**, next to `step(DT)` in
  `sim/main.js` (~line 265), *not* in `stepWorld(dt)`. `features.step()` runs
  at render cadence with variable `dt` — fine for a multi-second colour
  cycle, wrong for a moving object the player's `hitTest` has to see
  consistently. Mesh construction still goes through the pure-builder pattern
  called from `world.js`'s `activate()`, so `world.js` stays the only thing
  that mutates the scene graph.
- **Routes get their own flattened path.** Resolve a route (a list of node
  ids) into a genuinely connected walk at build time, bridging each node pad
  with a short connector. Unlike the global flatten, that one *is* continuous
  by construction, so a bot's own nearest-point search never hits the
  branching problem.

Collision: give each bot a persistent `circleCollider` added to
`collision.list` once, and mutate its `x`/`z` in place — `hitTest` reads
fields fresh every call, so `collide.js` needs no changes. Budget is fine:
currently 62 colliders and 0.003% of a 50 Hz tick, brute force, no spatial
index needed.

## Open questions to confirm before building M4

- Do bots brake for the **player** as well as each other? (Decision 2's
  wording implies yes.)
- Is hitting a bot the **same** consequence as hitting a building — the
  existing `rewindCar()` path — or something softer?
- Should Recover mode be **disabled** on graph worlds? It will not crash, but
  it produces nonsense episodes (teleports across the flattened array's fake
  seams, a Stanley controller correcting toward a locally wrong line) and can
  quietly poison a tub. Recommend gating the nav entry on `getWorld().graph`.

## Known deferred, deliberately

- **Ring-corner bends still have sharp outer corners.** They have no pad
  overhang to round into, and widening the bend pad would break its flush
  join (a bend's pad must equal the road width exactly). Needs a different
  approach than `buildKerbReturn`.
- **Blocks are sparse** — building `density` is 0.7. An easy knob; kept low
  to avoid re-cluttering after the roadway-clear fix.
- **No dedicated turn lanes or arrow signal heads.** Pavement turn arrows
  were also never added; the pad builder is where they'd go, and the
  160×120 legibility caveat applies to them as much as to signal heads.
- **Roundabout.** Out of scope from the start, not an oversight.
