#!/usr/bin/env node
/* _ga-dest.mjs — how far every named door is from the nearest
   carriageway, and what the mine looks like in plan. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(2500);
const out = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const road = [];
  for (const e of c.world.paths.edges) for (const p of e.points) road.push(p);
  const near = (x, z) => { let bd = Infinity; for (const r of road) { const d = Math.hypot(x - r.x, z - r.z); if (d < bd) bd = d; } return bd; };
  const rows = [];
  for (const [id, rec] of c.city.locations) {
    rows.push({ id, door: +near(rec.door.x, rec.door.z).toFixed(1), cen: +near(rec.center.x, rec.center.z).toFixed(1),
      x: +rec.center.x.toFixed(0), z: +rec.center.z.toFixed(0), yaw: +rec.loc.yaw.toFixed(2),
      w: rec.loc.size.w, d: rec.loc.size.d, dx: +rec.door.x.toFixed(1), dz: +rec.door.z.toFixed(1) });
  }
  rows.sort((a, b) => b.door - a.door);
  return rows;
});
for (const r of out) console.log(`${r.id.padEnd(16)} door->road ${String(r.door).padStart(6)} m  centre->road ${String(r.cen).padStart(6)} m  at ${r.x},${r.z} yaw ${r.yaw} size ${r.w}x${r.d} door ${r.dx},${r.dz}`);
await browser.close(); server.close();
