#!/usr/bin/env node
/* _ga-sandwich.mjs — the AABB of every prop body within 12 m of the
   Property Office, in whichever tree --root points at. Answers "did the
   sandwich board move, or did the ray?".                            */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0 ? resolve(process.argv[rootArg + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3000);
const out = await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE, world = c.phys.world;
  const rec = c.city.locations.get('propertyoffice');
  const cen = rec.center, gy = rec.groundY;
  const rows = [];
  for (const [id, r] of world.bodies) {
    if (!r.count) continue;
    const n = r.opts?.name || `#${id}`;
    if (!n.startsWith('prop.') && !n.startsWith('sign.')) continue;
    const cc = r.aabb.getCenter(new T.Vector3());
    const d = Math.hypot(cc.x - cen.x, cc.z - cen.z);
    if (d > 12) continue;
    rows.push({ name: n, d: +d.toFixed(2),
      x: +cc.x.toFixed(2), z: +cc.z.toFixed(2),
      loY: +(r.aabb.min.y - gy).toFixed(3), hiY: +(r.aabb.max.y - gy).toFixed(3),
      terrain: +(c.world.heightAt(cc.x, cc.z) - gy).toFixed(3) });
  }
  rows.sort((a, b) => a.d - b.d);
  return { groundY: +gy.toFixed(3), rows };
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
