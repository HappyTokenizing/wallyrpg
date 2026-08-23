#!/usr/bin/env node
/* VERIFY JUDGE #16 — what AIR_MIN's max-over-vertices hides.
   buildLip() keeps a tongue if `air` — the LARGEST clearance over the
   raster at ANY of its 135 vertices — is at least 0.5 m. That is a max,
   so a mat lying flat on a terrace with one corner past a step edge
   scores as a curtain. This walks all 80 placed tongues and reports,
   per tongue, how much of it is actually off the ground.
   node tools/_vj16/allclear.mjs                                       */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c)); rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b); }
  catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 240000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 240000 });
await page.waitForTimeout(4000);

const rows = await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE, W = c.world;
  const g = W.groundGroup.getObjectByName('terrain.lip');
  const v = new T.Vector3(); const VPI = 135; const out = [];
  for (const m of g.children) {
    if (!m.isMesh) continue; m.updateMatrixWorld(true);
    const P = m.geometry.attributes.position;
    for (let b = 0; b + VPI <= P.count; b += VPI) {
      let cx = 0, cz = 0; const cl = [];
      for (let i = b; i < b + VPI; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(m.matrixWorld);
        cx += v.x; cz += v.z;
        cl.push(v.y - W.heightAt(v.x, v.z));
      }
      cx /= VPI; cz /= VPI; cl.sort((a, b2) => a - b2);
      out.push({
        x: +cx.toFixed(1), z: +cz.toFixed(1),
        air: +cl[cl.length - 1].toFixed(3),         // what AIR_MIN sees
        p50: +cl[cl.length >> 1].toFixed(3),
        min: +cl[0].toFixed(3),
        onGround: cl.filter((q) => q < 0.10).length,   // buried / resting
        shallow: cl.filter((q) => q < 0.25).length,    // inside the grass field
      });
    }
  }
  return out;
});
await browser.close(); server.close();

rows.sort((a, b) => b.onGround - a.onGround);
console.log(`80 tongues; AIR_MIN 0.5 m is a MAX over 135 vertices.\n`);
console.log(`tongues with any vertex under 0.10 m of clearance : ${rows.filter((r) => r.onGround > 0).length}`);
console.log(`tongues with a THIRD or more of the mat under 0.10 : ${rows.filter((r) => r.onGround >= 45).length}`);
console.log(`tongues with a THIRD or more under 0.25 (grass)    : ${rows.filter((r) => r.shallow >= 45).length}`);
console.log(`tongues whose MEDIAN vertex is under 0.25 m        : ${rows.filter((r) => r.p50 < 0.25).length}`);
console.log(`\nworst 12 by "how much of the mat is on the ground":`);
console.log('     x       z     AIR(max)  median   min    <0.10  <0.25');
for (const r of rows.slice(0, 12)) {
  console.log(`  ${String(r.x).padStart(7)} ${String(r.z).padStart(7)}   ${String(r.air).padStart(7)} ${String(r.p50).padStart(7)} ${String(r.min).padStart(7)}   ${String(r.onGround).padStart(4)}  ${String(r.shallow).padStart(4)}`);
}
await writeFile('/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/vj16/allclear.json', JSON.stringify(rows, null, 1));
