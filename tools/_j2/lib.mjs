/* Judge harness v2 — my own rig, not the project's. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg',
  '.webp':'image/webp', '.svg':'image/svg+xml', '.glsl':'text/plain; charset=utf-8' };

export async function serve(root = ROOT) {
  const server = createServer(async (rq, rs) => {
    const url = decodeURIComponent((rq.url||'/').split('?')[0]);
    const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
    const p = join(root, rel);
    try {
      const info = await stat(p);
      if (info.isDirectory()) { rs.writeHead(404).end(); return; }
      const b = await readFile(p);
      rs.writeHead(200, { 'content-type': MIME[extname(p).toLowerCase()]||'application/octet-stream',
        'cache-control':'no-store' });
      rs.end(b);
    } catch { rs.writeHead(404).end('404 '+rel); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, close: () => server.close() };
}

export async function boot(opts = {}) {
  const { root = ROOT, query = 'skipIntro', viewport = { width: 1280, height: 720 },
          settle = 4000, quiet = false } = opts;
  const s = await serve(root);
  const browser = await chromium.launch({ channel: 'chrome',
    args: ['--enable-unsafe-swiftshader','--hide-scrollbars','--mute-audio','--force-color-profile=srgb'] });
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${s.port}/index.html?${query}`, { waitUntil:'load', timeout:120000 });
  await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout:120000 });
  await page.waitForTimeout(settle);
  const shot = async (name) => {
    const dir = join(ROOT, 'shots/j2');
    await mkdir(dir, { recursive: true });
    const path = join(dir, name.endsWith('.png') ? name : name + '.png');
    await page.screenshot({ path, animations: 'allow', timeout: 30000 });
    return path;
  };
  const close = async () => { await browser.close(); s.close(); };
  return { browser, page, errors, close, shot, port: s.port };
}

export const d2 = (n, k=2) => Number.isFinite(n) ? +n.toFixed(k) : n;
