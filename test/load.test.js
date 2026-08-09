import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser, waitFor, blockRealGamepads } from './helpers.js';

let server, browser, page, baseUrl;

before(async () => {
  ({ server, url: baseUrl } = await startServer());
  browser = await launchBrowser();
  page = await browser.newPage();
  await blockRealGamepads(page);
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

// Lives here rather than in training.test.js because none of it needs a
// trained model -- the copy is static markup, and this file already has the
// page up. Keeping it out of the training test keeps the slow suite slow for
// reasons that actually require training.
test('every Explain disclosure ships collapsed, is visible, and opens on demand', async () => {
  // Measured on the Train screen with the sample panel revealed, which is
  // the only state a user ever sees these in. Asserting on the DOM alone is
  // not enough: markup that exists but renders at zero size, or under a
  // hidden ancestor, passes every structural check while being invisible --
  // which is exactly how the first version of this shipped unnoticed.
  await page.click('.navbtn[data-mode="train"]');
  const panels = await page.evaluate(() => {
    document.getElementById('trainSample').hidden = false;
    return [...document.querySelectorAll('details.explain')].map((details) => {
      const summary = details.querySelector('summary');
      const box = summary.getBoundingClientRect();
      const closed = details.open;
      summary.click();
      const body = details.querySelector('.explainBody');
      return {
        id: details.id,
        closed, opened: details.open,
        label: summary.textContent.trim(),
        onScreen: !!summary.offsetParent,
        w: Math.round(box.width), h: Math.round(box.height),
        words: body ? body.textContent.trim().split(/\s+/).length : 0,
      };
    });
  });
  await page.click('.navbtn[data-mode="drive"]');

  assert.deepEqual(panels.map((p) => p.id), ['sampleExplain', 'lossExplain', 'steeringExplain'],
    'expected an Explain panel under the sample frame, the loss chart, and the steering chart');
  // Each button names its own section rather than saying a bare "Explain":
  // three identical controls down one scrolling page give no clue which
  // chart the prose that unfolds is about.
  const labels = {
    sampleExplain: 'Explain saliency map',
    lossExplain: 'Explain loss graph',
    steeringExplain: 'Explain steering fit',
  };
  for (const p of panels) {
    assert.equal(p.label, labels[p.id], `${p.id}: unexpected summary label`);
    assert.ok(p.onScreen, `${p.id}: not rendered -- it is under a hidden ancestor`);
    assert.ok(p.w > 60 && p.h > 16, `${p.id}: expected a pressable-sized control, got ${p.w}x${p.h}px`);
    // Collapsed by default: the charts and numbers are the panel's job, and
    // three walls of prose unfurled by default would bury them.
    assert.equal(p.closed, false, `${p.id}: expected it to start collapsed`);
    assert.equal(p.opened, true, `${p.id}: expected clicking the summary to open it`);
    assert.ok(p.words > 100, `${p.id}: expected substantive copy, got ${p.words} words`);
  }
});

test('the train screen labels its sections in reading order', async () => {
  const headers = await page.evaluate(() =>
    [...document.querySelectorAll('#screenTrain .trainSection')].map((el) => el.textContent.trim()));
  assert.deepEqual(headers, ['Saliency map', 'Loss graph', 'Steering fit'],
    'expected a header over each of the three train-screen sections, in page order');
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
