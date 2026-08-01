import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.md': 'text/markdown',
};

function requestHandler(req, res) {
  (async () => {
    let reqPath = decodeURIComponent(req.url.split('?')[0]);
    if (reqPath === '/') reqPath = '/index.html';
    const full = path.join(ROOT, reqPath);
    if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    try {
      const data = await readFile(full);
      // No cache headers at all lets browsers apply their own heuristic
      // caching, which mobile Chrome/Safari do far more aggressively than
      // desktop -- a plain reload tap on a phone can keep serving a stale
      // copy of a just-edited file with no way to force a real reload the
      // way desktop's Ctrl/Cmd+Shift+R does. This is a dev server for
      // live-editing content, so nothing it serves should ever be cached.
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  })();
}

// Serves the project root as static files (index.html, sim/*.js, data/*.js)
// with ES-module-compatible MIME types. Used both by `npm run serve` for
// manual driving and by the test suite, which starts/stops its own
// instance per file rather than relying on a manually-started server.
// Binds 0.0.0.0 rather than the implicit default so a phone/tablet on the
// same LAN can reach it too (for touch-layout testing) -- harmless for the
// test suite's own throwaway per-file instances, which only ever connect
// via localhost anyway.
export function startServer(port = 0, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = createServer(requestHandler);
    server.listen(port, host, () => resolve({ server, url: `http://localhost:${server.address().port}` }));
  });
}

function lanAddresses() {
  const addrs = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

// `node test/serve.js` for manual use, matching the earlier
// `python3 -m http.server` workflow but MIME-correct for modules.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 8734;
  startServer(port).then(({ url }) => {
    console.log(`serving ${ROOT}`);
    console.log(`  this machine:  ${url}`);
    for (const addr of lanAddresses()) {
      console.log(`  same network:  http://${addr}:${new URL(url).port}`);
    }
  });
}
