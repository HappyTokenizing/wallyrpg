/* _pj/lib.mjs — my own harness (judge 15). Serves the repo, boots the
   real game headless with WebGL2. Independent copy so nothing another
   workflow edits under tools/ can move under me mid-round. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };

export async function boot(opts = {}) {
  const { query = '?skipIntro', width = 1280, height = 720, wait = 3500 } = opts;
  const server = createServer(async (rq, rs) => {
    const c = decodeURIComponent(rq.url.split('?')[0]);
    try {
      const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
      rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
      rs.end(b);
    } catch { rs.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width, height } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${port}/index.html${query}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
  if (wait) await page.waitForTimeout(wait);
  return { page, browser, errs, port, close: async () => { await browser.close(); server.close(); } };
}
