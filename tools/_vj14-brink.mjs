#!/usr/bin/env node
/* VERIFY JUDGE #14 — photograph the sod lip AT A TONGUE, painted and
   plain, with the camera aimed at the tongue's own world position from
   downhill (the previous framing solved a camera off heightAt and put
   it inside the cliff face). Picks the tongues by measurement: the
   most proud, the steepest, and the one nearest the sand.
   WROOT=<tree> node tools/_vj14-brink.mjs                            */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.env.WROOT || '/Users/herwig/Documents/GitHub/wallyrpg';
const OUT = process.env.WOUT || '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/vj14/shots';
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
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(4000);
await mkdir(OUT, { recursive: true });

await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  window.__paintLip = function (on) {
    const g = c.world.groundGroup.getObjectByName('terrain.lip');
    if (!g) return 0;
    let n = 0;
    g.traverse((o) => {
      if (!o.isMesh) return;
      if (on) { o.userData._m = o.userData._m || o.material; o.material = new T.MeshBasicMaterial({ color: 0xff00ff }); }
      else if (o.userData._m) o.material = o.userData._m;
      n++;
    });
    return n;
  };
  /* tongue list with the vertex extremes we care about */
  window.__tg = function () {
    const W = c.world, grp = W.groundGroup.getObjectByName('terrain.lip');
    if (!grp) return null;
    const v = new T.Vector3(), rows = [], VPI = 135;
    for (const m of grp.children) {
      if (!m.isMesh) continue;
      m.updateMatrixWorld(true);
      const pos = m.geometry.attributes.position;
      for (let b = 0; b + VPI <= pos.count; b += VPI) {
        let sx = 0, sy = 0, sz = 0, k = 0, top = -Infinity, air = -Infinity;
        for (let i = b; i < b + VPI; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
          sx += v.x; sy += v.y; sz += v.z; k++;
          if (v.y > top) top = v.y;
          const d = v.y - W.heightAt(v.x, v.z);
          if (d > air) air = d;
        }
        const cx = sx / k, cy = sy / k, cz = sz / k, e = 2.5;
        const gx = (W.heightAt(cx + e, cz) - W.heightAt(cx - e, cz)) / (2 * e);
        const gz = (W.heightAt(cx, cz + e) - W.heightAt(cx, cz - e)) / (2 * e);
        rows.push({ x: +cx.toFixed(2), y: +cy.toFixed(2), z: +cz.toFixed(2),
          air: +air.toFixed(2), slope: +(Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI).toFixed(1),
          ux: gx / (Math.hypot(gx, gz) || 1), uz: gz / (Math.hypot(gx, gz) || 1),
          shore: W.shoreDistAt ? +W.shoreDistAt(cx, cz).toFixed(1) : null });
      }
    }
    return rows;
  };
  /* camera straight at a world point, from downhill and a little above */
  window.__look = function (p, dist, up) {
    const pos = new T.Vector3(p.x - p.ux * dist, p.y + up, p.z - p.uz * dist);
    const look = new T.Vector3(p.x, p.y, p.z);
    if (c.cam && c.cam.override) c.cam.override(pos, look, 45);
    const cam = c.camera;
    if (cam) { cam.position.copy(pos); cam.up.set(0, 1, 0); cam.lookAt(look); cam.updateMatrixWorld(true); }
    return [+pos.x.toFixed(1), +pos.y.toFixed(1), +pos.z.toFixed(1)];
  };
});

const tg = await page.evaluate(() => window.__tg());
console.log(`tongues ${tg.length}`);
const byAir = tg.slice().sort((a, b) => b.air - a.air);
const bySteep = tg.slice().sort((a, b) => b.slope - a.slope);
const byShore = tg.slice().sort((a, b) => a.shore - b.shore);
const picks = [
  ['mostair', byAir[0]],
  ['steepest', bySteep[0]],
  ['nearestsand', byShore[0]],
];
for (const [tag, p] of picks) console.log(tag, JSON.stringify(p));
for (const [tag, p] of picks) {
  for (const [d, u] of [[9, 2.5], [22, 8]]) {
    const cam = await page.evaluate(([q, dd, uu]) => window.__look(q, dd, uu), [p, d, u]);
    await page.waitForTimeout(700);
    await writeFile(`${OUT}/vj14b-${tag}-d${d}-plain.png`, await page.screenshot());
    await page.evaluate(() => window.__paintLip(true));
    await page.waitForTimeout(400);
    await page.evaluate(([q, dd, uu]) => window.__look(q, dd, uu), [p, d, u]);
    await page.waitForTimeout(300);
    await writeFile(`${OUT}/vj14b-${tag}-d${d}-magenta.png`, await page.screenshot());
    await page.evaluate(() => window.__paintLip(false));
    console.log(`   ${tag} d=${d} cam ${JSON.stringify(cam)}`);
  }
}
await browser.close(); server.close();
