import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

let ctx, page;

before(async () => {
  ctx = await setupSimPage();
  page = ctx.page;
  await page.evaluate(() => window.__sim.setWorld('city'));
});

after(async () => {
  await ctx.teardown();
});

test('traffic lights are placed with stop bars and start out of phase', async () => {
  const lights = await page.evaluate(() => window.__sim.featureStates('trafficLights'));
  assert.ok(lights.length >= 2, `expected several lights, got ${lights.length}`);

  for (const l of lights) {
    assert.ok(['red', 'yellow', 'green'].includes(l.phase), `bad phase ${l.phase}`);
    assert.notEqual(l.stopIdx, l.idx, 'stop bar sits at the signal instead of short of it');
  }

  // A synchronised green wave would never teach stopping.
  const distinct = new Set(lights.map((l) => l.phase));
  assert.ok(distinct.size >= 2, `all lights show ${[...distinct]} at once -- they are in phase`);
});

test('light phases advance over time', async () => {
  const before = await page.evaluate(() =>
    window.__sim.featureStates('trafficLights').map((l) => l.phase).join(','));
  await waitFor(page, (was) =>
    window.__sim.featureStates('trafficLights').map((l) => l.phase).join(',') !== was, {
    args: [before],
    timeout: 25000,
    message: 'no light changed phase -- the cycle is not running',
  });
});

// The whole feature rests on this: if the signal head is not inside the
// POV frustum from where the driver stops, then red and green produce
// identical training frames and no model can learn the difference. An
// arm swung to the wrong side put the head outside the horizontal FOV
// once already, with nothing failing to show it.
test('the signal head is inside the POV frame from the stop bar', async () => {
  const view = await page.evaluate(() => {
    const s = window.__sim;
    const light = s.featureStates('trafficLights')[0];
    s.placeCarAt(light.stopIdx, 0, 0);

    const V = s.V, H = V.heading;
    let best = null;
    s.scene.traverse((o) => {
      if (!o.isMesh || o.geometry?.type !== 'SphereGeometry') return;
      const p = new o.position.constructor();
      o.getWorldPosition(p);
      const dx = p.x - V.x, dz = p.z - V.z;
      const fwd = dx * Math.sin(H) + dz * Math.cos(H);
      const lat = dx * Math.cos(H) - dz * Math.sin(H);
      if (fwd < 1 || fwd > 25 || Math.abs(lat) > 12) return;
      if (!best || fwd < best.fwd) {
        best = {
          fwd,
          horiz: Math.abs(Math.atan2(lat, fwd) * 180 / Math.PI),
          // POV camera sits at 1.05m and is pitched down 0.20rad, so the
          // angle that matters is measured off that tilted axis.
          vert: Math.atan2(p.y - 1.05, fwd) * 180 / Math.PI + 0.20 * 180 / Math.PI,
        };
      }
    });
    return best;
  });

  assert.ok(view, 'no signal lamp found ahead of the car at the stop bar');
  // povCam is fov 80 vertical at 160x120 -> 40deg vertical half-angle,
  // ~48deg horizontal. Assert with margin so a near-miss still fails.
  assert.ok(view.horiz < 44,
    `signal is ${view.horiz.toFixed(1)}deg off-axis horizontally -- outside the ~48deg POV half-FOV`);
  assert.ok(view.vert < 36,
    `signal is ${view.vert.toFixed(1)}deg above the camera axis -- outside the 40deg POV half-FOV`);
});

test('worlds without the feature report no lights', async () => {
  await page.evaluate(() => window.__sim.setWorld('dusk-loop'));
  assert.deepEqual(await page.evaluate(() => window.__sim.featureStates('trafficLights')), []);
  assert.equal(await page.evaluate(() => window.__sim.collision.enabled), false,
    'a non-city world switched into collision mode');
  await page.evaluate(() => window.__sim.setWorld('city'));
});

test('the city collides against buildings and poles', async () => {
  const state = await page.evaluate(() => ({
    enabled: window.__sim.collision.enabled,
    n: window.__sim.collision.list.length,
  }));
  assert.equal(state.enabled, true, 'city is not in collision mode');
  assert.ok(state.n > 20, `expected a populated collider set, got ${state.n}`);
});

// The point of the rule change: leaving the middle of the road is normal
// city driving (pulling wide, stopping short of a line), so it must NOT
// yank the car back the way the race-circuit worlds do.
test('leaving the roadway does not reset the car', async () => {
  // Streetlight poles line the kerb ~5.2m out, so most of the loop cannot
  // be left without hitting one -- realistic, but it would confound this
  // test. With steer held at 0 the car's path is exactly a straight ray,
  // so the whole ray can be checked for clearance rather than a couple of
  // points beside the road: sampling only the perpendicular made this
  // flaky, because the car drifts forward as it goes sideways and could
  // still clip a pole further along.
  const ESCAPE = 0.9;   // rad off the road direction
  const launched = await page.evaluate((escape) => {
    const s = window.__sim;
    // Through the sim's own hit test, not a distance-to-centre check: a
    // building is a 7-13m box, so its centre can be 12m away while its
    // face is 5m away. Measuring to centres picked "clear" rays that ran
    // straight into a wall, which is what made this flaky.
    const clear = (x, z, m) => !s.hitTest(s.collision.list, x, z, m);
    for (let i = 0; i < s.road.SAMPLES; i += 3) {
      const c = s.road.centers[i], t = s.road.tangents[i];
      const roadHeading = Math.atan2(t.x, t.z);
      for (const side of [1, -1]) {
        // +heading offset moves toward -normal (see placeCarAt), so the
        // sign is flipped to leave on the side being tested.
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
  assert.ok(launched, 'no stretch of kerb was clear enough to drive off');

  // Catch the car well past the off-track threshold with throttle intact.
  // On any other world this exact state is impossible: the reset fires the
  // instant the threshold is crossed.
  const escaped = await waitFor(page, () => {
    const s = window.__sim;
    const limit = s.road.width / 2 + 0.15;
    return s.cte > limit + 0.8 && s.input.throttle > 0
      ? { cte: s.cte, thr: s.input.throttle } : null;
  }, { timeout: 8000, message: 'car never got clear of the roadway without being reset' });

  assert.equal(escaped.thr, 0.6, 'throttle was zeroed -- an off-track reset fired');
  await page.evaluate(() => { window.__sim.input.throttle = 0; });
});

test('hitting a building rewinds the car and cuts the throttle', async () => {
  // Aim at an actual building rather than just turning hard: at speed the
  // steering washes out to roughly a 3.3m turning circle, which fits
  // inside an 8m street, so a hard lock just drives in circles forever.
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

  // A rewind is bounded by how far the car could travel in REWIND_S; the
  // old centreline snap had no such bound and could move it anywhere.
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  assert.ok(moved < 60, `car moved ${moved.toFixed(1)}m on reset -- that is not a 3s rewind`);
  assert.equal(after.inside, false, 'car was left sitting on top of an obstacle');
});
