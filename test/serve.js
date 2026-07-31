import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
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
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
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
export function startServer(port = 0) {
  return new Promise((resolve) => {
    const server = createServer(requestHandler);
    server.listen(port, () => resolve({ server, url: `http://localhost:${server.address().port}` }));
  });
}

// `node test/serve.js` for manual use, matching the earlier
// `python3 -m http.server` workflow but MIME-correct for modules.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 8734;
  startServer(port).then(({ url }) => console.log(`serving ${ROOT} at ${url}`));
}
