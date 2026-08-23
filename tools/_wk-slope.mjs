/* _wk-slope.mjs — park a machine on measured gradients either side of
   the pitch clamp and report each wheel contact's error.
   node tools/_wk-slope.mjs [ride]
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const RIDE = process.argv[2] || 'bike';

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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);

const rows = await page.evaluate((ride) => {
  const c = window.WALLY.ctx;
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  const cy = c.world.city || c.city;
  const v = cy.doorPosition('apartment');
  /* survey the gradient around the apartment door, then pick spots
     either side of the clamp */
  const probes = [];
  for (let r = 4; r <= 90; r += 2) {
    for (let a = 0; a < 32; a++) {
      const th = (a / 32) * Math.PI * 2;
      const x = v.x + Math.cos(th) * r, z = v.z + Math.sin(th) * r;
      const yaw = th;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const hf = H(x + fx * 0.47, z + fz * 0.47), hr = H(x - fx * 0.47, z - fz * 0.47);
      if (hf == null || hr == null) continue;
      probes.push({ x, z, yaw, deg: Math.abs(Math.atan2(hf - hr, 0.94)) * 180 / Math.PI, r });
    }
  }
  const want = [5, 8, 11, 13, 15, 18, 22, 30, 37, 45, 55];
  const out = [];
  for (const d of want) {
    const p = probes.reduce((b, q) => (Math.abs(q.deg - d) < Math.abs(b.deg - d) ? q : b), probes[0]);
    if (Math.abs(p.deg - d) > 2.5) { out.push({ wanted: d, found: +p.deg.toFixed(2), skipped: true }); continue; }
    out.push({ wanted: d, dFromDoor: +p.r.toFixed(0), ...window.WALLY.debug.parkProbe(p.x, p.z, p.yaw, ride) });
  }
  return out;
}, RIDE);

for (const r of rows) console.error(JSON.stringify(r));
console.error('ERRS ' + JSON.stringify(errs.slice(0, 5)));
await browser.close();
server.close();
