import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage } from './helpers.js';

let ctx, page;

before(async () => {
  ctx = await setupSimPage();
  page = ctx.page;
});

after(async () => {
  await ctx.teardown();
});

// Reads the live road through the same object car.js reads, which is the
// point of the whole design: if this reflects the switch, so does physics.
const roadState = () => page.evaluate(() => {
  const { road } = window.__sim;
  return {
    id: window.__sim.getWorldId(),
    samples: road.SAMPLES,
    width: road.width,
    startIdx: road.startIdx,
    centerCount: road.centers.length,
    start: { x: road.centers[road.startIdx].x, z: road.centers[road.startIdx].z },
  };
});

test('the registry is exposed and a world is active on load', async () => {
  const worlds = await page.evaluate(() => window.__sim.listWorlds());
  assert.ok(worlds.length >= 2, `expected multiple worlds, got ${worlds.length}`);
  for (const w of worlds) {
    assert.ok(w.id && w.name, `world missing id/name: ${JSON.stringify(w)}`);
  }
  const active = await page.evaluate(() => window.__sim.getWorldId());
  assert.ok(worlds.some((w) => w.id === active), `active world ${active} not in registry`);
});

test('switching worlds swaps the road data the car drives on', async () => {
  const before = await roadState();
  const target = await page.evaluate(
    (cur) => window.__sim.listWorlds().find((w) => w.id !== cur).id,
    before.id,
  );

  const changed = await page.evaluate((id) => window.__sim.setWorld(id), target);
  assert.equal(changed, true, 'setWorld reported no change');

  const after = await roadState();
  assert.equal(after.id, target);
  assert.equal(after.centerCount, after.samples, 'centers array does not match SAMPLES');
  assert.notEqual(after.width, before.width, 'road width did not change between worlds');
  // The two worlds are different shapes, so their start lines cannot coincide.
  const moved = Math.hypot(after.start.x - before.start.x, after.start.z - before.start.z);
  assert.ok(moved > 1, `start line barely moved (${moved.toFixed(2)}m) -- road may not have rebuilt`);
});

test('the car is placed on the new start line, stopped', async () => {
  const state = await page.evaluate(() => {
    const { road } = window.__sim;
    const { V } = window.__sim;
    const c = road.centers[road.startIdx];
    const n = road.normalAt(road.startIdx);
    return {
      lateral: (V.x - c.x) * n.x + (V.z - c.z) * n.z,
      expected: road.width / 4,
      speed: V.speed, cte: window.__sim.cte, off: window.__sim.offTrack,
    };
  });
  assert.ok(Math.abs(state.lateral - state.expected) < 0.01,
    `car starts ${state.lateral.toFixed(2)}m laterally, expected right-lane centre at ${state.expected.toFixed(2)}m`);
  assert.equal(state.speed, 0, 'car still moving after a world switch');
  assert.equal(state.off, false, 'car reported off-track on a fresh start line');
});

test('switching back tears down cleanly and leaves one road in the scene', async () => {
  const worlds = await page.evaluate(() => window.__sim.listWorlds());

  // Cycle every world twice. A teardown that leaked would grow the scene
  // monotonically; the object count must instead come back to exactly what
  // that same world had the first time around.
  const counts = [];
  for (let pass = 0; pass < 2; pass++) {
    for (const w of worlds) {
      counts.push(await page.evaluate((id) => {
        window.__sim.setWorld(id);
        let n = 0;
        window.__sim.scene.traverse(() => n++);
        return { id, n };
      }, w.id));
    }
  }

  for (let i = 0; i < worlds.length; i++) {
    const first = counts[i], second = counts[i + worlds.length];
    assert.equal(first.id, second.id, 'cycle order mismatch');
    assert.equal(second.n, first.n,
      `${first.id}: scene had ${first.n} objects on the first pass and ${second.n} on the second -- teardown leaked`);
  }
});

test('re-selecting the active world is a no-op', async () => {
  const active = await page.evaluate(() => window.__sim.getWorldId());
  const changed = await page.evaluate((id) => window.__sim.setWorld(id), active);
  assert.equal(changed, false, 'setWorld re-activated the world already live');
});

test('the menu lists every world and marks the active one', async () => {
  const ui = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#worldList button')];
    return btns.map((b) => ({ id: b.dataset.world, current: b.getAttribute('aria-current') === 'true' }));
  });
  const worlds = await page.evaluate(() => window.__sim.listWorlds());
  assert.deepEqual(ui.map((u) => u.id), worlds.map((w) => w.id), 'menu does not match the registry');
  assert.equal(ui.filter((u) => u.current).length, 1, 'expected exactly one world marked active');
});

test('clicking a world button switches worlds', async () => {
  const active = await page.evaluate(() => window.__sim.getWorldId());
  const target = await page.evaluate(
    (cur) => window.__sim.listWorlds().find((w) => w.id !== cur).id,
    active,
  );

  // Open the menu and expand the world section first -- the buttons live
  // in a collapsed submenu (display:none) until then, so this also covers
  // the section actually being reachable through the real UI path.
  await page.click('#modelMenuBtn');
  await page.click('.menuSection[data-submenu="world"]');
  await page.click(`#worldList button[data-world="${target}"]`);
  assert.equal(await page.evaluate(() => window.__sim.getWorldId()), target);
  const marked = await page.evaluate(
    (id) => document.querySelector(`#worldList button[data-world="${id}"]`).getAttribute('aria-current'),
    target,
  );
  assert.equal(marked, 'true', 'clicked world was not marked active');
});

// Regression: switching worlds while parked used to change the road data
// without repainting, so the old world stayed on screen until you touched
// the throttle or reloaded. main.js skips rendering once the car has been
// idle for IDLE_SETTLE_S, and a world swap changes the scene without
// moving the car -- see wakeRender() there.
//
// The #pov canvas is a plain 2D canvas that only receives putImageData
// inside main.js's render block, which makes its pixels a direct readout
// of "did a frame actually get drawn" -- unlike the WebGL canvas, whose
// drawing buffer isn't readable after compositing.
test('switching worlds while parked repaints immediately', async () => {
  const pov = () => page.evaluate(() => document.getElementById('pov').toDataURL());

  await page.evaluate(() => { window.__sim.input.throttle = 0; });
  // Outlast IDLE_SETTLE_S (1.5s) so rendering has definitely gone idle --
  // the state you're in while picking a world out of the menu.
  await new Promise((r) => setTimeout(r, 2500));

  const before = await pov();
  const switched = await page.evaluate(() => {
    const next = window.__sim.listWorlds().find((w) => w.id !== window.__sim.getWorldId());
    window.__sim.setWorld(next.id);
    return next.id;
  });
  await new Promise((r) => setTimeout(r, 800));

  assert.equal(await page.evaluate(() => window.__sim.getWorldId()), switched);
  assert.notEqual(await pov(), before,
    'POV canvas is unchanged after a parked world switch -- the new world was never drawn');
});

// Regression: sim/scenery.js sets buildings back along each road sample's
// normal, which silently assumed there is only ever ONE road to be set back
// from. That held for a closed loop (its far side is half a map away) and
// broke the moment a world had a road graph: street-grid's edges run tens
// of metres apart with stub arms crossing perpendicular, so plots set back
// from one edge landed squarely on another and walled the streets off.
//
// Asserted across every world, not just the graph one -- "nothing solid
// stands on the roadway" is not a street-grid rule, it's the rule.
test('no world puts a solid object on its own roadway', async () => {
  const worlds = await page.evaluate(() => window.__sim.listWorlds());
  for (const w of worlds) {
    const blocked = await page.evaluate((id) => {
      const s = window.__sim;
      s.setWorld(id);
      const half = s.road.width / 2;
      for (let i = 0; i < s.road.SAMPLES; i++) {
        const c = s.road.centers[i];
        const hit = s.hitTest(s.collision.list, c.x, c.z, half);
        if (hit) return { i, kind: hit.kind, x: hit.x, z: hit.z, cx: c.x, cz: c.z };
      }
      return null;
    }, w.id);
    assert.equal(blocked, null,
      `${w.id}: a ${blocked?.kind} at (${blocked?.x?.toFixed(1)}, ${blocked?.z?.toFixed(1)}) ` +
      `sits on the roadway at sample ${blocked?.i}`);
  }
});

test('the chosen world survives a reload', async () => {
  const chosen = await page.evaluate(() => window.__sim.getWorldId());
  await page.reload({ waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__sim && window.__sim.tub.loaded, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__sim.getWorldId()), chosen);
});
