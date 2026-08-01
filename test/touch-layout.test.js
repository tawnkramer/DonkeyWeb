import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

// The cam preview is hidden on touch devices to free up screen space. The
// risk that buys is silent: the POV canvas it displays is also the buffer
// the recorder reads, so if hiding it ever broke recording or the model's
// input, nothing on screen would say so -- you'd just get a tub full of
// blank frames. These tests pin that it doesn't.
let page, teardown;

before(async () => {
  ({ page, teardown } = await setupSimPage());
  // isMobile+hasTouch is what actually flips the browser's reported
  // pointer capability -- see the note in joystick.test.js for why
  // page.emulateMediaFeatures() can't be used for 'pointer'.
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.evaluate(() => { __sim.setMode('drive'); });
});
after(() => teardown());

test('touch layout hides the cam preview and lifts telemetry to the top', async () => {
  const s = await page.evaluate(() => {
    const nav = document.getElementById('navbar').getBoundingClientRect();
    const telem = document.getElementById('telem').getBoundingClientRect();
    return {
      coarse: matchMedia('(pointer: coarse)').matches,
      povVisible: getComputedStyle(document.getElementById('povwrap')).display !== 'none',
      telemVisible: getComputedStyle(document.getElementById('telem')).display !== 'none',
      telemTop: telem.top,
      navBottom: nav.bottom,
      telemRecVisible: getComputedStyle(document.getElementById('telemRec')).display !== 'none',
    };
  });
  assert.equal(s.coarse, true, 'viewport did not report a coarse pointer');
  assert.equal(s.povVisible, false, 'cam preview should be hidden on touch devices');
  assert.equal(s.telemVisible, true, 'telemetry should still be visible');
  assert.ok(s.telemTop >= s.navBottom, `telemetry (${s.telemTop}) should sit below the nav bar (${s.navBottom})`);
  assert.ok(s.telemTop < 140, `telemetry should be near the top, got ${s.telemTop}`);
  assert.equal(s.telemRecVisible, true, 'the telemetry strip needs its own recording dot here');
});

test('recording still captures real frames with the preview hidden', async () => {
  await page.evaluate(async () => {
    const mod = await import('/data/tub.js');
    mod.tub.frames.length = 0;
    mod.tub.bins.fill(0);
    __sim.input.throttle = 0.5;
  });

  await waitFor(page, () => window.__sim.tub.frames.length > 2, {
    timeout: 15000,
    message: 'no frames recorded while driving with the preview hidden',
  });

  // The indicator the user actually has on a phone must light up.
  const recLit = await page.evaluate(() =>
    document.getElementById('telemRec').classList.contains('active'));
  assert.equal(recLit, true, 'telemetry recording dot should be lit while recording');

  // A hidden canvas still has its bitmap, so the stored JPEG must be a
  // real 160x120 frame -- not blank, not zero-sized.
  const frame = await page.evaluate(async () => {
    const { tub, waitForTubIdle } = await import('/data/tub.js');
    await waitForTubIdle();
    const { dbGet } = await import('/data/db.js');
    const rec = await dbGet(tub.frames[0].id);
    if (!rec || !rec.img) return null;
    const bmp = await createImageBitmap(rec.img);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let distinct = new Set();
    for (let i = 0; i < px.length; i += 4) distinct.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
    return { w: bmp.width, h: bmp.height, bytes: rec.img.size, distinctColors: distinct.size };
  });

  assert.ok(frame, 'recorded frame had no stored image');
  assert.equal(frame.w, 160, 'recorded frame should be 160px wide');
  assert.equal(frame.h, 120, 'recorded frame should be 120px tall');
  assert.ok(frame.bytes > 0, 'recorded JPEG should not be empty');
  assert.ok(frame.distinctColors > 5,
    `recorded frame looks blank (${frame.distinctColors} distinct colours) -- hiding the preview must not blank the POV buffer`);

  await page.evaluate(() => { __sim.input.throttle = 0; });
});
