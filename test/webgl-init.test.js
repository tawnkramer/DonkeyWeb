import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser, waitFor } from './helpers.js';

// iOS Safari hands back an already-dead WebGL context instead of null, which
// used to blow up inside three.js's precision probe and leave the phone with
// nothing but a stack trace. Both halves of the recovery are pinned here.
//
// The dead context is faked by stubbing getContext, installed with
// evaluateOnNewDocument so it is in place before the module graph runs. Chrome
// itself never does this, so there is no other way to exercise the path.
let server, browser, baseUrl;

before(async () => {
  ({ server, url: baseUrl } = await startServer());
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

// deadCount: how many of the first WebGL contexts come back dead. Anything
// past that is a real context from the browser.
async function pageWithDeadContexts(deadCount) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((n) => {
    const real = HTMLCanvasElement.prototype.getContext;
    let handed = 0;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (/webgl/.test(type) && handed < n) {
        handed++;
        // Shaped like Safari's: the object exists and reports a live context,
        // every actual query returns null.
        return {
          isContextLost: () => false,
          getShaderPrecisionFormat: () => null,
          VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632,
          HIGH_FLOAT: 36338, MEDIUM_FLOAT: 36337,
        };
      }
      return real.call(this, type, attrs);
    };
  }, deadCount);
  await page.goto(`${baseUrl}/index.html`, { waitUntil: 'load', timeout: 20000 });
  return page;
}

test('a dead context on the first try is retried, and the sim still boots', async () => {
  const page = await pageWithDeadContexts(1);
  try {
    await waitFor(page, () => !!window.__sim, {
      timeout: 30000,
      message: 'sim never started after a dead first WebGL context',
    });
    // The retry swaps in a new canvas element; the rest of the app (CSS
    // sizing, pointer handlers, the resize observer) finds it by id, so a
    // replacement that loses the id would boot and then quietly misbehave.
    const view = await page.evaluate(() => {
      const el = document.getElementById('view');
      return el && { tag: el.tagName, count: document.querySelectorAll('#view').length };
    });
    assert.deepEqual(view, { tag: 'CANVAS', count: 1 });
    const errbox = await page.evaluate(() => !!document.getElementById('errbox'));
    assert.equal(errbox, false, 'a recovered start should not show an error overlay');
  } finally {
    await page.close();
  }
});

test('when every attempt is dead, the reason is shown on screen', async () => {
  const page = await pageWithDeadContexts(99);
  try {
    await waitFor(page, () => {
      const box = document.getElementById('errbox');
      return !!box && box.innerText.includes('3D graphics unavailable');
    }, { message: 'unusable WebGL never surfaced a readable message' });
    const text = await page.evaluate(() => document.getElementById('errbox').innerText);
    assert.match(text, /already lost/, 'the message should say what went wrong');
    assert.doesNotMatch(text, /getShaderPrecisionFormat/,
      'should fail on our own check, not inside three.js');
  } finally {
    await page.close();
  }
});
