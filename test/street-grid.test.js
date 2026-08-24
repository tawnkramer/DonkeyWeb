import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

// Street-grid integration coverage, extended milestone by milestone (same
// as test/city.test.js). This section re-confirms, against the real
// running sim, what test/roadgraph.test.js already checked against the
// builder in isolation: that street-grid is drivable and that the
// collision-reset model (borrowed from the city loop) still holds once the
// road is a branching graph instead of one closed spline.

let ctx, page;

before(async () => {
  ctx = await setupSimPage();
  page = ctx.page;
  await page.evaluate(() => window.__sim.setWorld('street-grid'));
});

after(async () => {
  await ctx.teardown();
});

test('every street-grid junction has one coordinated signal per incoming approach', async () => {
  const state = await page.evaluate(() => ({
    enabled: window.__sim.collision.enabled,
    n: window.__sim.collision.list.length,
    signals: window.__sim.featureStates('intersectionSignals'),
  }));
  assert.equal(state.enabled, true, 'street-grid is not in collision mode');
  assert.ok(state.n > 10, `expected a populated collider set, got ${state.n}`);
  // Four 4-ways plus eight T junctions: 4*4 + 8*3 incoming approaches.
  assert.equal(state.signals.length, 40, 'missing an incoming junction approach signal');
  const byNode = Map.groupBy(state.signals, s => s.node);
  assert.equal(byNode.size, 12, 'every degree-3/4 junction should be signalised');
  for (const [node, signals] of byNode) {
    for (const axis of ['NS', 'EW']) {
      const phases = signals.filter(s => s.axis === axis).map(s => s.phase);
      if (phases.length > 1) {
        assert.equal(new Set(phases).size, 1, `${node} ${axis} approaches are not synchronised`);
      }
    }
    const greenAxes = new Set(signals.filter(s => s.phase === 'green').map(s => s.axis));
    assert.ok(greenAxes.size <= 1, `${node} gives green to crossing traffic`);
  }
  for (const signal of state.signals) {
    assert.notEqual(signal.stopIdx, undefined, `missing stop bar for ${signal.edge}`);
  }
});

test('the flattened road matches SAMPLES and the car starts on it, stopped', async () => {
  const state = await page.evaluate(() => {
    const { road, V } = window.__sim;
    const c = road.centers[road.startIdx];
    return {
      centerCount: road.centers.length, samples: road.SAMPLES,
      dist: Math.hypot(V.x - c.x, V.z - c.z), speed: V.speed,
      dragOnOffTrack: road.dragOnOffTrack,
    };
  });
  assert.equal(state.centerCount, state.samples);
  assert.ok(state.dist < 0.01, `car is ${state.dist.toFixed(2)}m from the start sample`);
  assert.equal(state.speed, 0);
  assert.equal(state.dragOnOffTrack, false, 'grass-drag should be disabled on a graph world');
});

// Same rule as the city loop, and for the same reason: a street is somewhere
// to move around in, so straying from the flattened centerline -- which on
// this world is also a bookkeeping artifact, not an intended line -- must
// not yank the car back.
test('leaving the roadway does not reset the car', async () => {
  const ESCAPE = 0.9;
  const launched = await page.evaluate((escape) => {
    const s = window.__sim;
    const clear = (x, z, m) => !s.hitTest(s.collision.list, x, z, m);
    for (let i = 0; i < s.road.SAMPLES; i += 3) {
      const c = s.road.centers[i], t = s.road.tangents[i];
      const roadHeading = Math.atan2(t.x, t.z);
      for (const side of [1, -1]) {
        const h = roadHeading + -side * escape;
        const dirX = Math.sin(h), dirZ = Math.cos(h);
        let ok = true;
        for (let d = 1; d <= 12 && ok; d += 0.5) {
          if (!clear(c.x + dirX * d, c.z + dirZ * d, 1.6)) ok = false;
        }
        if (!ok) continue;
        s.placeCarAt(i, 0, -side * escape);
        s.input.steer = 0;
        s.input.throttle = 0.6;
        return { i, side };
      }
    }
    return null;
  }, ESCAPE);
  assert.ok(launched, 'no stretch of street was clear enough to drive off');

  const escaped = await waitFor(page, () => {
    const s = window.__sim;
    const limit = s.road.width / 2 + 0.15;
    return s.cte > limit + 0.8 && s.input.throttle > 0
      ? { cte: s.cte, thr: s.input.throttle } : null;
  }, { timeout: 8000, message: 'car never got clear of the street without being reset' });

  assert.equal(escaped.thr, 0.6, 'throttle was zeroed -- an off-track reset fired');
  await page.evaluate(() => { window.__sim.input.throttle = 0; });
});

test('hitting a building rewinds the car and cuts the throttle', async () => {
  const launch = await page.evaluate(() => {
    const s = window.__sim;
    const target = s.collision.list.find((c) => c.kind === 'box');
    let best = 0, bd = Infinity;
    for (let i = 0; i < s.road.SAMPLES; i++) {
      const c = s.road.centers[i];
      const d = Math.hypot(c.x - target.x, c.z - target.z);
      if (d < bd) { bd = d; best = i; }
    }
    const c = s.road.centers[best], t = s.road.tangents[best];
    const roadHeading = Math.atan2(t.x, t.z);
    const toTarget = Math.atan2(target.x - c.x, target.z - c.z);
    let delta = toTarget - roadHeading;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    s.placeCarAt(best, 0, delta);
    s.input.steer = 0;
    s.input.throttle = 0.7;
    return { idx: best, x: s.V.x, z: s.V.z };
  });

  const before = { x: launch.x, z: launch.z };

  await waitFor(page, () => window.__sim.input.throttle === 0 && window.__sim.V.speed === 0, {
    timeout: 15000,
    message: 'never collided, or the collision did not stop the car',
  });

  const after = await page.evaluate(() => ({
    x: window.__sim.V.x, z: window.__sim.V.z,
    inside: !!window.__sim.collision.list.length &&
      window.__sim.collision.list.some((c) => {
        const dx = window.__sim.V.x - c.x, dz = window.__sim.V.z - c.z;
        return Math.hypot(dx, dz) < 1.5;
      }),
  }));

  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  assert.ok(moved < 60, `car moved ${moved.toFixed(1)}m on reset -- that is not a 3s rewind`);
  assert.equal(after.inside, false, 'car was left sitting on top of an obstacle');
});

// A crash near the very start of a run has no rewind history to fall back
// on (car.js's histOldest() returns null) -- on the loop worlds that falls
// back to the nearest centreline sample, which is fine there because it IS
// the road you crashed off. On a graph world the flattened array is not one
// continuous path (see sim/roadgraph.js), so car.js instead falls back to
// the authored spawn point. This drives that fallback directly rather than
// waiting out REWIND_S to empty a real history.
test('a crash with no rewind history falls back to the spawn point, not a nearest-sample jump', async () => {
  const spawn = await page.evaluate(() => {
    const c = window.__sim.road.centers[window.__sim.road.startIdx];
    return { x: c.x, z: c.z };
  });

  // Teleport onto the target itself, via placeCarAt (never write V.x/V.z by
  // hand -- see main.js's window.__sim comment on why that leaves nearestIdx
  // stale). placeCarAt() also clears the rewind ring, so the very next
  // physics tick's collision has no history to rewind into and must take
  // the no-history fallback in car.js.
  await page.evaluate(() => {
    const s = window.__sim;
    const target = s.collision.list.find((c) => c.kind === 'box');
    let best = 0, bd = Infinity;
    for (let i = 0; i < s.road.SAMPLES; i++) {
      const c = s.road.centers[i];
      const d = Math.hypot(c.x - target.x, c.z - target.z);
      if (d < bd) { bd = d; best = i; }
    }
    const c = s.road.centers[best], n = s.road.normalAt(best);
    const lateral = (target.x - c.x) * n.x + (target.z - c.z) * n.z;
    s.placeCarAt(best, lateral, 0);
    s.input.throttle = 0;
  });

  await waitFor(page, (sp) => {
    const s = window.__sim;
    return Math.hypot(s.V.x - sp.x, s.V.z - sp.z) < 0.5 ? true : null;
  }, {
    args: [spawn], timeout: 5000,
    message: 'car was not sent back to the spawn point after a no-history collision',
  });
});
