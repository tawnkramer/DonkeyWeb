import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser } from './helpers.js';

// Regression tests for a bug that shipped unnoticed because every other
// test (and every desktop dev machine) runs at devicePixelRatio 1, where
// it is invisible by coincidence.
//
// <canvas> is a REPLACED element, so a positioned one takes its used size
// from its INTRINSIC size -- the width/height attributes, which three.js
// sets to viewport*devicePixelRatio -- and `inset:0` does NOT stretch it.
// With no explicit CSS size, a dpr=2 phone therefore displayed the canvas
// at 780x1688 CSS px inside a 390x844 viewport: 2x too large, anchored
// top-left, so only the top-left quadrant of the scene was on screen.
// At dpr=1 the buffer size happens to equal the viewport size, so the
// same code looks perfect.
//
// These run their own browser per case rather than using setupSimPage()
// because deviceScaleFactor is a browser-level setting that has to be in
// place before the page loads.
let server, browser, baseUrl;

before(async () => {
  ({ server, url: baseUrl } = await startServer());
  browser = await launchBrowser();
});
after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

async function measure({ width, height, deviceScaleFactor }) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor });
    await page.goto(`${baseUrl}/index.html`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForFunction(() => window.__sim && window.__sim.tub.loaded, { timeout: 30000 });
    return await page.evaluate(() => {
      const c = document.getElementById('view');
      const r = c.getBoundingClientRect();
      return {
        rectW: r.width, rectH: r.height,
        rectLeft: r.left, rectTop: r.top,
        bufW: c.width, bufH: c.height,
        innerW: innerWidth, innerH: innerHeight,
        dpr: devicePixelRatio,
      };
    });
  } finally {
    await page.close();
  }
}

for (const dpr of [1, 2, 3]) {
  test(`canvas displays at exactly viewport size at devicePixelRatio ${dpr}`, async () => {
    const m = await measure({ width: 390, height: 844, deviceScaleFactor: dpr });

    assert.equal(m.dpr, dpr, 'deviceScaleFactor did not take effect');
    assert.equal(m.rectW, m.innerW, `canvas displayed width must equal viewport width at dpr ${dpr}`);
    assert.equal(m.rectH, m.innerH, `canvas displayed height must equal viewport height at dpr ${dpr}`);
    assert.equal(m.rectLeft, 0, 'canvas must be anchored at the left edge');
    assert.equal(m.rectTop, 0, 'canvas must be anchored at the top edge');
  });
}

test('drawing buffer scales with devicePixelRatio for HiDPI sharpness', async () => {
  // The display size being pinned must not come at the cost of rendering
  // at 1x on a HiDPI screen -- the buffer should still be dpr times the
  // CSS size (capped at 2 by scene.js's setPixelRatio).
  const m = await measure({ width: 390, height: 844, deviceScaleFactor: 2 });
  assert.equal(m.bufW, m.rectW * 2, 'drawing buffer width should be 2x the displayed width at dpr 2');
  assert.equal(m.bufH, m.rectH * 2, 'drawing buffer height should be 2x the displayed height at dpr 2');
});

test('camera aspect matches the canvas box, so the scene is never stretched', async () => {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2 }); // landscape
    await page.goto(`${baseUrl}/index.html`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForFunction(() => window.__sim && window.__sim.tub.loaded, { timeout: 30000 });
    const { aspect, rectAspect } = await page.evaluate(() => {
      const c = document.getElementById('view');
      const r = c.getBoundingClientRect();
      // chaseCam isn't on __sim directly; scene.js exports it.
      return import('/sim/scene.js').then((m) => ({
        aspect: m.chaseCam.aspect,
        rectAspect: r.width / r.height,
      }));
    });
    assert.ok(Math.abs(aspect - rectAspect) < 0.01,
      `camera aspect ${aspect} should match the canvas box aspect ${rectAspect}`);
  } finally {
    await page.close();
  }
});
