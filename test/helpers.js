import { stat } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { startServer } from './serve.js';

export { startServer };

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try { await stat(candidate); return candidate; } catch { /* try next */ }
  }
  throw new Error(
    `No Chrome/Chromium executable found (tried: ${CHROME_CANDIDATES.join(', ')}). ` +
    `Set CHROME_PATH to override.`
  );
}

// This environment has no GPU, hence --enable-unsafe-swiftshader (software
// WebGL) and --disable-gpu-sandbox/--no-sandbox. Drop these on a machine
// with real GPU + sandbox support if that ever changes.
export async function launchBrowser() {
  const executablePath = await findChrome();
  return puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
  });
}

// Polls `fn` (evaluated in the page) until it returns a truthy value,
// instead of sleeping a fixed, guessed duration. Prefer this everywhere:
// cold IndexedDB opens and the CDN-hosted three.js import have both shown
// multi-second, environment-dependent latency in this sandboxed headless
// setup (fast on real hardware, slow here), so a hardcoded delay is either
// flaky (too short) or wastes time in every run (padded long "to be safe").
// extraArgs are forwarded to page.evaluate(fn, ...extraArgs), same as
// Puppeteer's own evaluate -- use this to pass in values captured in the
// Node-side test (fn runs in the browser and can't close over them).
export async function waitFor(page, fn, { timeout = 8000, interval = 50, message, args: extraArgs = [] } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeout) {
    try {
      const result = await page.evaluate(fn, ...extraArgs);
      if (result) return result;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  const detail = [message, lastErr && `last error: ${lastErr.message}`].filter(Boolean).join(' -- ');
  throw new Error(`waitFor timed out after ${timeout}ms${detail ? `: ${detail}` : ''}`);
}

// Frames persist in IndexedDB across page loads by design (that's the
// point) -- tests that need a clean slate must ask for one explicitly.
export async function resetIndexedDB(page) {
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('donkeyweb');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // still open elsewhere (e.g. another tab); best-effort
  }));
}

// Common setup shared by every test file: start a static server, launch
// one browser for the whole file, load the app fresh with an empty tub.
// Returns { server, browser, page, baseUrl } plus a matching teardown().
export async function setupSimPage() {
  const { server, url: baseUrl } = await startServer();
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/index.html`, { waitUntil: 'load', timeout: 20000 });
  await resetIndexedDB(page);
  await page.reload({ waitUntil: 'load', timeout: 20000 });
  await waitFor(page, () => window.__sim && window.__sim.tub.loaded, {
    timeout: 30000,
    message: 'window.__sim.tub.loaded never became true',
  });
  return {
    server, browser, page, baseUrl,
    async teardown() {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
