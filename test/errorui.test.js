import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

// The overlay exists because phones have no console: an uncaught error
// there is invisible, the page just stops. If the overlay silently stopped
// working we would be debugging blind again, so pin it.
//
// Errors are raised from an injected same-origin <script> rather than from
// page.evaluate(): the browser treats evaluate'd code as cross-origin and
// masks the real message as a bare "Script error.", which would make this
// test unable to prove the thing it exists to prove.
let page, teardown;

before(async () => { ({ page, teardown } = await setupSimPage()); });
after(() => teardown());

async function raiseInPage(code) {
  await page.evaluate((src) => {
    const s = document.createElement('script');
    s.textContent = src;
    document.head.appendChild(s);
  }, code);
}

test('an uncaught error is shown on screen with its message', async () => {
  await raiseInPage('setTimeout(function(){ throw new Error("boom-from-test"); }, 0);');
  await waitFor(page, () => {
    const box = document.getElementById('errbox');
    return !!box && box.innerText.includes('boom-from-test');
  }, { message: 'uncaught error never surfaced in the overlay' });
});

test('an unhandled promise rejection is shown on screen', async () => {
  await raiseInPage('Promise.reject(new Error("rejected-from-test"));');
  await waitFor(page, () => {
    const box = document.getElementById('errbox');
    return !!box && box.innerText.includes('rejected-from-test');
  }, { message: 'unhandled rejection never surfaced in the overlay' });
});

test('a failed module import is shown on screen', async () => {
  // The failure mode this was actually built for: a bad/stale module graph
  // leaves a blank frozen page with nothing on screen to explain it.
  await raiseInPage('var s=document.createElement("script");s.type="module";' +
    's.src="/sim/does-not-exist.js";document.head.appendChild(s);');
  await waitFor(page, () => {
    const box = document.getElementById('errbox');
    return !!box && box.innerText.includes('does-not-exist');
  }, { message: 'a failed module load never surfaced in the overlay' });
});

test('the report includes the user agent and the captured errors', async () => {
  const report = await page.evaluate(() => window.__errors.report());
  assert.ok(report.includes('Mozilla'), 'report should start with the user agent');
  assert.ok(report.includes('boom-from-test'), 'report should include captured errors');
});
