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
    document.getElementById('backpropPanel').hidden = false;
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

  assert.deepEqual(panels.map((p) => p.id), ['sampleExplain', 'bpExplain', 'lossExplain', 'steeringExplain'],
    'expected an Explain panel under the sample frame, the backprop stage, the loss chart, and the steering chart');
  // Each button names its own section rather than saying a bare "Explain":
  // three identical controls down one scrolling page give no clue which
  // chart the prose that unfolds is about.
  const labels = {
    sampleExplain: 'Explain saliency map',
    bpExplain: 'Explain backprop',
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
  assert.deepEqual(headers, ['Saliency map', 'Backprop, one step at a time', 'Loss graph', 'Steering fit'],
    'expected a header over each of the four train-screen sections, in page order');
});

// The state the picker ships in, before anything is recorded: a slider that
// is live with nothing to scrub invites a drag that silently does nothing.
// Must run before the test below, which fills the tub.
test('the sample frame picker ships disabled until there are frames', async () => {
  await page.click('.navbtn[data-mode="train"]');
  const picker = await page.evaluate(() => {
    document.getElementById('trainSample').hidden = false;
    const slider = document.getElementById('sampleFrameSlider');
    const label = document.querySelector('label[for="sampleFrameSlider"]');
    return {
      disabled: slider.disabled,
      max: slider.max,
      onScreen: !!slider.offsetParent,
      label: label && label.textContent.trim(),
      tag: document.getElementById('sampleFrameTag').textContent.trim(),
    };
  });
  await page.click('.navbtn[data-mode="drive"]');
  assert.equal(picker.disabled, true, 'expected the frame slider to start disabled');
  assert.equal(picker.max, '0', 'expected an empty range before any frames exist');
  assert.ok(picker.onScreen, 'expected the frame slider to be rendered in the sample panel');
  assert.equal(picker.label, 'frame', 'expected the slider to be labelled');
  assert.equal(picker.tag, '—', 'expected a placeholder position readout');
});

// Scrubbing with no model is the whole point of the picker -- you line up a
// frame worth explaining BEFORE spending three minutes training on it -- and
// it needs no trained model to test, so it belongs in the fast suite.
test('the frame picker scrubs recorded frames with no model trained', async () => {
  await waitFor(page, () => window.__sim.tub.loaded, {
    message: 'tub never finished loading, so tubPush would be a no-op',
  });
  await page.evaluate(async () => {
    const { tubPush, waitForTubIdle } = await import('/data/tub.js');
    // Steering ramps with position, so the sharpest frame is the last one and
    // "did it open on the sharpest turn" has a single unambiguous answer.
    for (let i = 0; i < 12; i++) tubPush(i * 0.05, i / 12, 0.4);
    await waitForTubIdle();
  });
  await page.click('.navbtn[data-mode="train"]');

  const opened = await waitFor(page, () => {
    const canvas = document.getElementById('sampleCanvas');
    if (document.getElementById('trainSample').hidden || !canvas.width) return null;
    const frames = window.__sim.tub.frames;
    return {
      count: frames.length,
      lastId: frames[frames.length - 1].id,
      lastSteer: frames[frames.length - 1].steer,
      slider: document.getElementById('sampleFrameSlider').value,
      max: document.getElementById('sampleFrameSlider').max,
      disabled: document.getElementById('sampleFrameSlider').disabled,
      tag: document.getElementById('sampleFrameTag').textContent,
      target: document.getElementById('sampleSteerTarget').textContent,
      predicted: document.getElementById('sampleSteerPred').textContent,
      overlayHidden: document.getElementById('sampleSaliency').hidden,
      pendingHidden: document.getElementById('saliencyPending').hidden,
      w: canvas.width, h: canvas.height,
    };
  }, { timeout: 10000, message: 'sample panel never appeared from tub frames alone' });

  assert.equal(opened.disabled, false, 'expected the slider to go live once the tub has frames');
  assert.equal(opened.max, String(opened.count - 1), 'expected the slider to span the whole recording');
  assert.equal(opened.slider, String(opened.count - 1),
    'expected to open on the sharpest-steering frame, which here is the last');
  assert.equal(opened.tag, `${opened.count} / ${opened.count}`, `unexpected position readout "${opened.tag}"`);
  assert.equal(opened.target, opened.lastSteer.toFixed(3),
    'expected the recorded steering to come straight from the tub');
  // No model exists, so there is nothing to predict with and nothing to wait
  // for. Both must read as absent rather than as pending.
  assert.equal(opened.predicted, '—', 'expected no prediction without a model');
  assert.equal(opened.overlayHidden, true, 'expected no saliency overlay without a model');
  assert.equal(opened.pendingHidden, true,
    'expected no "computing" hint with no model -- nothing is coming');
  assert.equal(opened.w, 160, `expected the frame drawn at model input width, got ${opened.w}`);
  assert.equal(opened.h, 120, `expected the frame drawn at model input height, got ${opened.h}`);

  // And scrubbing moves it, still with no worker in the picture.
  const scrubbed = await page.evaluate(async () => {
    const slider = document.getElementById('sampleFrameSlider');
    slider.value = '0';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 200; i++) {
      const shown = document.getElementById('sampleSteerTarget').textContent;
      if (shown === window.__sim.tub.frames[0].steer.toFixed(3)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    return {
      target: document.getElementById('sampleSteerTarget').textContent,
      want: window.__sim.tub.frames[0].steer.toFixed(3),
      tag: document.getElementById('sampleFrameTag').textContent,
    };
  });
  assert.equal(scrubbed.target, scrubbed.want, 'expected scrubbing to move to the requested frame');
  assert.equal(scrubbed.tag, `1 / ${opened.count}`, `unexpected position readout "${scrubbed.tag}"`);

  await page.click('.navbtn[data-mode="drive"]');
});

// Recorded laps were lost once to exactly this: a disk low on space, and a
// browser well within its rights to reclaim best-effort storage from a
// dev-server origin. The request has to happen on the startup path, before
// there is anything worth losing, so what is asserted is that loading the
// page is enough to trigger it -- no driving, no recording, no interaction.
test('loading the page asks the browser to keep recorded laps', async () => {
  const fresh = await browser.newPage();
  try {
    // Counted from before the document exists, since the call happens during
    // module evaluation -- a spy installed after goto() would always miss it.
    await fresh.evaluateOnNewDocument(() => {
      window.__persistCalls = 0;
      if (navigator.storage && navigator.storage.persist) {
        const real = navigator.storage.persist.bind(navigator.storage);
        navigator.storage.persist = () => { window.__persistCalls++; return real(); };
      }
    });
    await fresh.goto(`${baseUrl}/index.html`, { waitUntil: 'load', timeout: 20000 });
    const state = await waitFor(fresh, () => {
      if (!window.__sim) return null;
      return navigator.storage.persisted().then((persisted) => ({
        persisted, calls: window.__persistCalls,
      }));
    }, { timeout: 15000, message: 'persistence was never requested on load' });
    // Either the call was made, or the origin was already marked persistent
    // from an earlier load in this profile -- both mean the laps are safe,
    // and re-asking when already granted is deliberately skipped.
    assert.ok(state.calls > 0 || state.persisted,
      'expected startup to request persistent storage (or find it already granted)');

    const estimate = await fresh.evaluate(() => window.__sim.storageEstimate());
    assert.ok(estimate && Number.isFinite(estimate.quota) && estimate.quota > 0,
      `expected a usable storage estimate, got ${JSON.stringify(estimate)}`);
  } finally {
    await fresh.close();
  }
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
