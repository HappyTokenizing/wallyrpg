/* shared harness for the verify judge — my own, not the round's tools */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

export const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glsl': 'text/plain',
  '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

export async function serve() {
  const server = createServer(async (rq, rs) => {
    const c = decodeURIComponent(rq.url.split('?')[0]);
    try {
      const p = join(ROOT, c === '/' ? 'index.html' : c);
      if (!p.startsWith(ROOT)) { rs.writeHead(403).end(); return; }
      const b = await readFile(p);
      rs.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
      rs.end(b);
    } catch { rs.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

export function reporter() {
  const rows = [];
  let fails = 0;
  const ok = (cond, msg, extra = '') => {
    if (!cond) fails++;
    rows.push({ pass: !!cond, msg, extra });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '   ' + extra : ''}`);
    return !!cond;
  };
  return { ok, rows, get fails() { return fails; } };
}
