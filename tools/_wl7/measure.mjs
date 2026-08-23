#!/usr/bin/env node
/* ART-DIRECTOR MEASUREMENT PASS on the sod lip.
   No pictures: the numbers the art decision rests on.
     - per-vertex clearance over the raster for every PLACED tongue
       (AIR_MIN is a max, so this is what it hides)
     - the run structure: is a tongue part of a fringe along a brink,
       or is it a lone slab?
     - apparent size: how wide is a tongue in degrees from 12 m
   node tools/_wl7/measure.mjs                                       */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.WROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.WOUT || '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/wl7';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c)); rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b); }
  catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const t0 = Date.now();
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 300000 });
await page.waitForTimeout(3000);
console.log(`boot ${(Date.now() - t0) / 1000}s`);
await mkdir(OUT, { recursive: true });

const data = await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE, W = c.world;
  const g = W.groundGroup.getObjectByName('terrain.lip');
  const VPI = 135, v = new T.Vector3();
  const tongues = [];
  for (const m of g.children) {
    if (!m.isMesh) continue;
    m.updateMatrixWorld(true);
    const P = m.geometry.attributes.position;
    for (let b = 0; b + VPI <= P.count; b += VPI) {
      let cx = 0, cy = 0, cz = 0;
      let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9, miny = 1e9, maxy = -1e9;
      const cl = [];
      for (let i = b; i < b + VPI; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(m.matrixWorld);
        cx += v.x; cy += v.y; cz += v.z;
        if (v.x < minx) minx = v.x; if (v.x > maxx) maxx = v.x;
        if (v.z < minz) minz = v.z; if (v.z > maxz) maxz = v.z;
        if (v.y < miny) miny = v.y; if (v.y > maxy) maxy = v.y;
        cl.push(v.y - W.heightAt(v.x, v.z));
      }
      cx /= VPI; cy /= VPI; cz /= VPI;
      cl.sort((a, b2) => a - b2);
      const q = (f) => +cl[Math.min(cl.length - 1, Math.floor(f * cl.length))].toFixed(3);
      tongues.push({
        x: +cx.toFixed(1), y: +cy.toFixed(2), z: +cz.toFixed(1),
        span: +Math.max(maxx - minx, maxz - minz).toFixed(2),
        tall: +(maxy - miny).toFixed(2),
        min: q(0), p25: q(0.25), p50: q(0.5), p75: q(0.75), max: +cl[cl.length - 1].toFixed(3),
        u10: cl.filter((a) => a < 0.10).length,
        u25: cl.filter((a) => a < 0.25).length,
        u0: cl.filter((a) => a < 0).length,
      });
    }
  }
  /* run structure: neighbours within R along the brink */
  for (const t of tongues) {
    t.n6 = tongues.filter((o) => o !== t && Math.hypot(o.x - t.x, o.z - t.z) < 6).length;
    t.n12 = tongues.filter((o) => o !== t && Math.hypot(o.x - t.x, o.z - t.z) < 12).length;
  }
  const census = W.terrain.lipGateCensus();
  let tris = 0;
  g.traverse((o) => { if (o.isMesh) tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3; });
  return { tongues, census, tris, meshes: g.children.length };
});

const T = data.tongues;
const pc = (n) => `${n}/${T.length} (${(100 * n / T.length).toFixed(0)}%)`;
console.log(`\nplaced tongues: ${T.length}   picks: ${data.census.length}   merged meshes: ${data.meshes}   triangles: ${data.tris}`);
console.log(`\n--- burial: clearance over the terrain raster, per vertex (135 per tongue) ---`);
console.log(`  any vertex under 0.10 m            : ${pc(T.filter((t) => t.u10 > 0).length)}`);
console.log(`  a THIRD or more under 0.10 m       : ${pc(T.filter((t) => t.u10 >= 45).length)}`);
console.log(`  HALF or more under 0.10 m          : ${pc(T.filter((t) => t.u10 >= 68).length)}`);
console.log(`  median vertex under 0.25 m         : ${pc(T.filter((t) => t.p50 < 0.25).length)}`);
console.log(`  median vertex under 0.10 m         : ${pc(T.filter((t) => t.p50 < 0.10).length)}`);
console.log(`  median vertex UNDERGROUND (<0)     : ${pc(T.filter((t) => t.p50 < 0).length)}`);
const worst = [...T].sort((a, b) => a.p50 - b.p50).slice(0, 6);
for (const w of worst) console.log(`    worst: (${w.x},${w.z})  p50 ${w.p50}  min ${w.min}  max ${w.max}  under0.10 ${w.u10}/135  underground ${w.u0}/135`);
console.log(`\n--- fringe or slab: neighbours along the brink ---`);
for (const k of [0, 1, 2, 3]) console.log(`  tongues with ${k === 3 ? '>=3' : k} neighbour(s) within 6 m : ${pc(T.filter((t) => (k === 3 ? t.n6 >= 3 : t.n6 === k)).length)}`);
console.log(`  alone within 12 m                  : ${pc(T.filter((t) => t.n12 === 0).length)}`);
console.log(`\n--- size ---`);
const spans = T.map((t) => t.span).sort((a, b) => a - b);
console.log(`  horizontal span: min ${spans[0]}  p50 ${spans[spans.length >> 1]}  max ${spans[spans.length - 1]} m`);
const talls = T.map((t) => t.tall).sort((a, b) => a - b);
console.log(`  vertical extent: min ${talls[0]}  p50 ${talls[talls.length >> 1]}  max ${talls[talls.length - 1]} m`);
console.log(`  a ${spans[spans.length >> 1]} m span at 12 m subtends ${(2 * Math.atan(spans[spans.length >> 1] / 24) * 180 / Math.PI).toFixed(1)} deg — ${(1280 * (spans[spans.length >> 1] / 24) / Math.tan(25 * Math.PI / 180)).toFixed(0)} px wide at 1280/50deg`);
await writeFile(join(OUT, 'measure.json'), JSON.stringify(data, null, 1));
console.log(`\nwrote ${join(OUT, 'measure.json')}   total ${(Date.now() - t0) / 1000}s`);
await browser.close(); server.close();
