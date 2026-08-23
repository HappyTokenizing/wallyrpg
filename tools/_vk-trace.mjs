/* _vk-trace.mjs — call WALLY.debug.driveTrace and cross-check it.
   Also proves it leaves the player where it found him.
   node tools/_vk-trace.mjs */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
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
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);

const out = await page.evaluate(() => {
  const c = window.WALLY.ctx, w = c.wally, d = window.WALLY.debug;
  const before = { pos: [w.root.position.x, w.root.position.y, w.root.position.z], riding: w.riding, ride: w.rideId };
  const res = {};
  const snap = () => ({ pos: [+w.root.position.x.toFixed(3), +w.root.position.y.toFixed(3), +w.root.position.z.toFixed(3)],
    sim: w.controller ? [+w.controller.simPosition.x.toFixed(3), +w.controller.simPosition.y.toFixed(3), +w.controller.simPosition.z.toFixed(3)] : null,
    riding: w.riding, ride: w.rideId, vel: w.controller ? +w.controller.planarSpeed.toFixed(3) : null });
  res.step0 = snap();
  res.trace1 = d.driveTrace('bike', 5.2, 48);
  res.step1 = snap();
  res.trace2 = d.driveTrace('bike', 5.2, 48);
  res.step2 = snap();
  window.__SNAP = snap;
  const after = { pos: [w.root.position.x, w.root.position.y, w.root.position.z], riding: w.riding, ride: w.rideId };
  return { before, after, res, has: typeof d.driveTrace };
});
await page.waitForTimeout(1500);
out.settled = await page.evaluate(() => window.__SNAP());
console.log(JSON.stringify(out, null, 1));
console.error('ERRS ' + JSON.stringify(errs.slice(0, 6)));
await browser.close();
server.close();
