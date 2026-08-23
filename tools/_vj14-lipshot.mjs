#!/usr/bin/env node
/* VERIFY JUDGE #14 — paint the sod lip magenta, pick a REAL brink by
   measurement rather than by inheritance, and photograph both it and
   (390, 214). Also prints, per spot, what the lip there actually is:
   how proud of the collision ground, how much daylight under it, and
   whether the ground under it is walkable.
   WROOT=<tree> WTAG=<tag> node lipshot.mjs                            */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.env.WROOT || '/Users/herwig/Documents/GitHub/wallyrpg';
const TAG = process.env.WTAG || 'vj14';
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
  const c = window.WALLY.ctx, T = window.WALLY.THREE, phys = c.phys;
  const frames = (n) => new Promise((res) => { let k = 0; const t = () => (++k >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
  window.__place3 = async function (x, z) {
    const p = phys.player;
    p.teleport(new T.Vector3(x, phys.groundAt(x, z).y + 0.1, z)); await frames(30);
    p.teleport(new T.Vector3(x, phys.groundAt(x, z).y + 0.1, z)); await frames(40);
    return { y: +p.simPosition.y.toFixed(2), grounded: p.grounded };
  };
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
  /* Look along the fall line at the brink, from downhill and above.
     Uses cam.override() — the cooperative stand-down world.js's own
     flyTo uses — so the follow rig does not snatch the camera back
     between the eval and the screenshot. */
  window.__frame = function (x, z, dist = 14, up = 6) {
    const W = c.world, e = 6;
    const gx = (W.heightAt(x + e, z) - W.heightAt(x - e, z)) / (2 * e);
    const gz = (W.heightAt(x, z + e) - W.heightAt(x, z - e)) / (2 * e);
    const m = Math.hypot(gx, gz) || 1;
    const ux = gx / m, uz = gz / m;                     // uphill
    const pos = new T.Vector3(x - ux * dist, W.heightAt(x, z) + up, z - uz * dist);
    const look = new T.Vector3(x + ux * 2, W.heightAt(x + ux * 2, z + uz * 2) + 0.5, z + uz * 2);
    if (c.cam && c.cam.override) c.cam.override(pos, look, 50);
    const cam = c.camera || c.render?.camera;
    if (cam) { cam.position.copy(pos); cam.up.set(0, 1, 0); cam.lookAt(look); cam.updateMatrixWorld(true); }
    return [+pos.x.toFixed(1), +pos.y.toFixed(1), +pos.z.toFixed(1)];
  };
  window.__release = function () { if (c.cam && c.cam.releaseOverride) c.cam.releaseOverride(); };
  /* per-TONGUE census: 135 verts per tongue (makeSodGeo, 45 tris).
     For each tongue: anchor, terrain slope at anchor, max proud over
     heightAt, whether the ground under the proudest vertex is walkable,
     and the daylight under the tongue (vertex y minus ground y at the
     most overhanging vertex). */
  window.__tongues = function () {
    const W = c.world, grp = W.groundGroup.getObjectByName('terrain.lip');
    if (!grp) return null;
    const COS = Math.cos(48 * Math.PI / 180);
    const v = new T.Vector3(), n = new T.Vector3();
    const rows = [];
    const VPI = 135;
    for (const m of grp.children) {
      if (!m.isMesh) continue;
      m.updateMatrixWorld(true);
      const pos = m.geometry.attributes.position;
      for (let base = 0; base + VPI <= pos.count; base += VPI) {
        let sx = 0, sz = 0, k = 0, proud = -Infinity, px = 0, pz = 0, pny = 0, air = -Infinity, ax = 0, az = 0;
        for (let i = base; i < base + VPI; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
          sx += v.x; sz += v.z; k++;
          const h = W.heightAt(v.x, v.z);
          const d = v.y - h;
          if (d > proud) { proud = d; px = v.x; pz = v.z; W.normalAt(v.x, v.z, n); pny = n.y; }
          if (d > air) { air = d; ax = v.x; az = v.z; }
        }
        const cx = sx / k, cz = sz / k, e = 2.5;
        const gx = (W.heightAt(cx + e, cz) - W.heightAt(cx - e, cz)) / (2 * e);
        const gz = (W.heightAt(cx, cz + e) - W.heightAt(cx, cz - e)) / (2 * e);
        const slopeDeg = Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
        W.normalAt(cx, cz, n);
        rows.push({ x: +cx.toFixed(2), z: +cz.toFixed(2), slopeDeg: +slopeDeg.toFixed(1),
          proud: +proud.toFixed(3), atX: +px.toFixed(1), atZ: +pz.toFixed(1), proudNy: +pny.toFixed(3),
          walkableUnderProud: pny >= COS, centreNy: +n.y.toFixed(3), h: +W.heightAt(cx, cz).toFixed(2) });
      }
    }
    return rows;
  };
  /* what is at (x,z): collision ground, drawn ground with and without
     the lip, nearest lip tongue, shore distance */
  window.__spot = function (x, z) {
    const W = c.world;
    const BASE = /outline|hull|contactShadow|cloth|drift|grass|foliage|detail|bush|reed|water|sky|cloud/i;
    const LIP = /\blip\b/i;
    const tg = (withLip) => {
      const out = [];
      for (const r of [W.groundGroup, c.city?.root].filter(Boolean)) r.traverse((o) => {
        if (!o.isMesh && !o.isInstancedMesh) return;
        if (o.userData.isOutlineHull || o.userData.noPrepass) return;
        const nm = o.name || '';
        if (BASE.test(nm)) return;
        if (!withLip && LIP.test(nm)) return;
        for (let p = o; p; p = p.parent) if (p.visible === false) return;
        out.push(o);
      });
      return out;
    };
    const ray = new T.Raycaster(); const D = new T.Vector3(0, -1, 0); const O = new T.Vector3();
    const cast = (from, t) => { O.set(x, from + 0.45, z); ray.set(O, D); ray.far = 6; const h = ray.intersectObjects(t, false); return h.length ? { y: +h[0].point.y.toFixed(3), on: h[0].object.name || '?' } : null; };
    const g = phys.groundAt(x, z);
    const n = new T.Vector3(); W.normalAt(x, z, n);
    return { x, z, gy: +g.y.toFixed(3), hit: g.hit, ny: +n.y.toFixed(3),
      shore: W.shoreDistAt ? +W.shoreDistAt(x, z).toFixed(2) : null,
      h: +W.heightAt(x, z).toFixed(3),
      drawnWithLip: cast(g.y, tg(true)), drawnNoLip: cast(g.y, tg(false)) };
  };
});

const tongues = await page.evaluate(() => window.__tongues());
if (!tongues) { console.log('NO LIP GROUP'); await browser.close(); server.close(); process.exit(0); }
console.log(`tongues: ${tongues.length}`);
const overWalk = tongues.filter((t) => t.walkableUnderProud && t.proud > 0.12);
console.log(`tongues standing >0.12 m proud over WALKABLE ground: ${overWalk.length}`);
for (const t of overWalk.slice(0, 8)) console.log('   ', JSON.stringify(t));
const steep = tongues.slice().sort((a, b) => b.slopeDeg - a.slopeDeg);
console.log('steepest tongues (a real brink):');
for (const t of steep.slice(0, 5)) console.log('   ', JSON.stringify(t));

const brink = steep[0];
const spots = [[390, 214, 'named'], [+brink.x.toFixed(2), +brink.z.toFixed(2), 'brink'], [313, -276, 'oldbrink']];
for (const [x, z, tag] of spots) {
  const s = await page.evaluate(([a, b]) => window.__spot(a, b), [x, z]);
  console.log(`\nSPOT ${tag} ${x},${z}: ${JSON.stringify(s)}`);
  const at = await page.evaluate(([a, b]) => window.__place3(a, b), [x, z]);
  console.log(`   player ${JSON.stringify(at)}`);
  await page.waitForTimeout(900);
  await writeFile(`${OUT}/${TAG}-${tag}-${x}_${z}-plain.png`, await page.screenshot());
  const n = await page.evaluate(() => window.__paintLip(true));
  await page.waitForTimeout(500);
  await writeFile(`${OUT}/${TAG}-${tag}-${x}_${z}-magenta.png`, await page.screenshot());
  /* and an oblique look down the fall line, painted */
  const cam = await page.evaluate(([a, b]) => window.__frame(a, b, 16, 7), [x, z]);
  await page.waitForTimeout(600);
  await writeFile(`${OUT}/${TAG}-${tag}-${x}_${z}-magenta-fall.png`, await page.screenshot());
  /* the same fall-line frame UNPAINTED, so the magenta can be checked
     against what the player actually sees there */
  await page.evaluate(() => window.__paintLip(false));
  await page.waitForTimeout(400);
  await writeFile(`${OUT}/${TAG}-${tag}-${x}_${z}-plain-fall.png`, await page.screenshot());
  await page.evaluate(() => window.__release());
  console.log(`   shot (${n} lip meshes painted, fall-line cam ${JSON.stringify(cam)})`);
}
await browser.close(); server.close();
