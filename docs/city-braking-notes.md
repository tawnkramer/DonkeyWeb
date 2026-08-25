# Teaching the city model to stop — working notes

Status: **not started.** The `worlds` branch added the city, its traffic
lights, collision reset, and driving sessions. Training a model that
actually stops at a red is the next piece and has not been attempted yet.
These are notes-to-self so the thread can be picked up cold.

## The headline: braking is already expressible end to end

The instinct was "this needs a new brake input to the model, and probably a
new control scheme to go with it." Reading the code, that turns out to be
mostly wrong, and the real work is elsewhere. Braking is not a missing
channel — it is a sign bit on a channel that already exists everywhere:

| Stage | State |
|---|---|
| Input devices | `input.throttle` is signed `[-1,1]` on all three devices — `S`/`ArrowDown` (`sim/input.js` keymap), scroll-wheel down, gamepad `L2` / stick-back (`sim/gamepad.js`, `rawTrigger = gas - brake`) |
| Physics | `sim/car.js` — `input.throttle < 0` applies `V.BRAKE` (12.0 m/s²) above 0.3 m/s, reverse below it |
| Recording | `tubPush(simTime, input.steer, input.throttle)` writes the raw signed value; nothing rectifies it |
| Session gating | `updateSession()` in `sim/main.js` already keeps recording through lift-off, braking, and sitting at a red — that was the point of replacing the old flat `input.throttle > 0` gate |
| Model | `n_outputs1` is a **linear** head (`train/model.js`), no activation floor — it can emit negative throttle |

So a lap where the driver brakes for a red light already lands in the tub
with negative throttle labels, and the architecture can already fit them.

## The one thing that is actually broken

`train/autopilot.js`, in `pilotPredict()`:

```js
// Throttle floor at 0: recorded throttle is always positive (recording
// gates on throttle > 0), so a negative prediction is extrapolation
// noise, not a braking skill the model could have learned.
pilot.throttle = Math.max(0, Math.min(1, throttle));
```

**That comment is now stale, and the clamp with it.** It is justified by the
old flat `input.throttle > 0` recording gate — the exact gate the `worlds`
branch replaced (see the long comment above `SESSION_IDLE_S` in
`sim/main.js`, which spells out why: a tub with no `throttle <= 0` label
anywhere structurally cannot teach a model to stop). With the new session
logic, a negative prediction can now be a learned braking skill, and this
line throws it away.

This is a loose end from the `worlds` work, not new feature work. Worth
fixing as part of finishing that branch rather than deferring — the clamp
becomes actively wrong the moment anyone records a city lap.

Changing it is not a one-liner though, because of the next item.

## Open problems

### 1. The stopped-at-a-red ambiguity — this is where a new *input* is justified

Classic behaviour-cloning inertia/causal-confusion trap. Two situations look
nearly identical to a single-frame image model:

- approaching a red light at 8 m/s → correct action: brake hard
- already stopped at that same red light → correct action: hold at zero

The camera sees roughly the same pixels. The disambiguator is **the car's own
speed**, which the model currently has no access to at all — the input is
image-only.

So the genuinely new model input is probably **speed**, not "brake". Sketch:
an auxiliary scalar input concatenated into the flatten/dense junction in
`buildModel()`, which means `V.speed` also has to be recorded per frame in
`data/tub.js` (new field alongside `steer`/`throttle`) and fed at inference
from `pilotPredict()`. That is a tub schema change — worth checking what it
does to `loadTub()` and the existing recorded data before committing to it.

Worth trying the cheap thing first: the light changes colour, and red vs
green is a large, saturated, high-contrast cue. A single frame may carry
enough signal to at least *initiate* the stop, even if holding the stop is
where it falls apart. Establish that failure mode empirically before paying
for a schema change.

### 2. Reverse creep

`sim/car.js` treats `throttle < 0` below 0.3 m/s as **reverse**, not brake.
A model that has learned "red light → negative throttle" and keeps predicting
it after the car stops will roll backwards through the intersection. Options,
roughly in order of preference:

- clamp in `pilotPredict()` to `>= 0` **only when nearly stopped** — cheap,
  keeps braking, kills reverse, no data change
- separate the brake and reverse ranges in the physics
- solve it properly via the speed input in (1) so the model learns to
  release on its own

### 3. Class imbalance

**Status: mitigated in `train/worker.js` (`balanceByThrottle`).** This
turned out not to need the other items first — a driver reported it
directly: a red-light wait holds ~0 throttle for the whole `cycle.red`
duration at 20 Hz, so "stopped" frames swamped everything else in the tub,
including the brief take of accelerating away on green, and training
regressed toward the stopped majority.

The fix bins the *training* split by throttle (10 bins over [-1,1]) and
resamples each bin toward the median occupied bin's count: bins above the
target are thinned, bins below it are repeated (capped at 8x so one rare
frame can't be duplicated without bound). Validation is left untouched so
its metric still reports against the tub's real distribution.

Not yet done: a throttle validation metric (item 4 below) to actually
measure whether this helped, and the loss-weighting-between-heads
alternative was not needed once resampling closed the gap. Revisit if
under-braking (or under-accelerating) persists once item 4 lands.

### 4. There is no throttle metric at all

`toleranceAccuracy` is registered only for `n_outputs0` (steering), and
`train/worker.js` reports `logs.val_n_outputs0_toleranceAccuracy` as *the*
validation accuracy. The comment in `model.js` explains why — "throttle is
often intentionally near-constant, so it would make this number less useful"
— which was true for oval laps and is precisely wrong for the city, where
throttle is the whole lesson. Needs its own throttle metric before any of the
above can be evaluated; otherwise there is no way to tell whether a change
helped.

Related and helpful: the `claude/donkeyweb-training-enhancements-azfanm`
branch adds a per-epoch sample panel to the Train tab showing the recorded
frame with recorded/predicted/error for **both** steer and throttle. That is
already a partial answer to this — a red-light frame in that panel would show
the throttle error directly. Land that branch before doing the metric work.

## Control scheme

Less of a problem than expected, but with one real gap.

The existing continuous-steering rationale applies unchanged to braking:
bang-bang input makes poor cloning data. Ranking of what we have today:

- **Gamepad `L2`** — analog, pressure-graded, the right capture path. The
  reference DualSense has confirmed analog triggers. Braking data recorded
  this way should be good.
- **Scroll wheel** — continuous but *positional*, not sprung. It holds
  wherever it is left, so a stop means winding the wheel down to negative and
  remembering to wind it back. Usable, awkward, and easy to leave parked in
  reverse.
- **Keyboard `S`** — bang-bang, full `-1`. Produces exactly the
  snap-correction data the mouse steering was introduced to avoid.

So: no new scheme strictly required, but **braking laps should be recorded on
the pad**, and that should probably be stated in the UI rather than assumed.
The genuine gap is the desktop mouse+wheel user, who has no sprung analog
brake — worth considering a held-key-with-ramp (press-and-hold ramps toward
`-1` over ~300 ms instead of snapping) so keyboard braking degrades
gracefully rather than being unusable for data collection.

## Suggested order

1. Fix the stale clamp + comment in `train/autopilot.js`, with the
   near-stopped guard from (2) so it cannot reverse.
2. Land the training-enhancements branch for the throttle readout.
3. Add a throttle validation metric (4) — nothing below is measurable
   without it.
4. Record city laps on the pad, look at what the model actually does at a
   red, and only then decide whether (1)'s speed input is needed.
5. ~~Imbalance (3) if under-braking persists after that.~~ Landed early —
   see item 3 above.
