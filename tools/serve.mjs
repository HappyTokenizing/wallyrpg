#!/usr/bin/env node
/* ============================================================
   serve.mjs — static dev server for WALLY RPG.

   The game is plain ES modules plus a vendored three.js, so it needs
   nothing but correct MIME types and no caching. No bundler, no HMR,
   no build step: edit a file under src/ and reload.

   Binds the port given in $PORT (the harness assigns one), falling
   back to 0 = "any free port". It deliberately does NOT hardcode a
   port — another project already owns 5173.
   ============================================================ */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 0);
const HOST = process.env.HOST ?? '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.glsl': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
  const path = join(ROOT, rel);

  // Never serve outside the project root.
  if (!path.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      res.writeHead(302, { location: url.replace(/\/?$/, '/') + 'index.html' }).end();
      return;
    }
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      // The whole point of the dev server is seeing edits immediately.
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${rel}`);
  }
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`WALLY RPG dev server -> http://${HOST}:${port}/`);
  console.log(`serving ${ROOT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
