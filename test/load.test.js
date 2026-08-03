import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser, waitFor } from './helpers.js';

let server, browser, page, baseUrl;

before(async () => {
  ({ server, url: baseUrl } = await startServer());
  browser = await launchBrowser();
  page = await browser.newPage();
});

after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

test('loads with no console errors, failed requests, or bad HTTP statuses', async () => {
  const issues = [];
  page.on('console', (m) => { if (m.type() === 'error') issues.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => issues.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => issues.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => {
    // favicon.ico is a known, accepted gap -- no favicon file exists yet.
    if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) issues.push(`bad status ${r.status()}: ${r.url()}`);
  });

  await page.goto(`${baseUrl}/index.html`, { waitUntil: 'load', timeout: 20000 });
  await waitFor(page, () => window.__sim && window.__sim.scene.children.length > 0, {
    message: 'scene never populated',
  });

  assert.deepEqual(issues, []);
});

test('window.__sim debug hook exposes a fully-built scene', async () => {
  // Counted recursively, not as scene.children.length: the active world's
  // road and scenery each hang off the scene as a single Group (that
  // grouping is what lets sim/world.js dispose a world wholesale), so the
  // scene has only a handful of DIRECT children no matter how much is
  // built. Road ribbon + dashes + checker + cones + ~90 trees + car parts
  // still add up to a few hundred objects in total; a low number here
  // means something failed to build silently.
  const objectCount = await page.evaluate(() => {
    let n = 0;
    window.__sim.scene.traverse(() => n++);
    return n;
  });
  assert.ok(objectCount > 100, `expected a populated scene, got ${objectCount} objects`);
});
