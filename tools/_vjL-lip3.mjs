#!/usr/bin/env node
/* VERIFY JUDGE — paint the sod lip magenta and LOOK at it. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.env.WROOT;
const TAG = process.env.WTAG || 'x';
const OUT = '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/shots';
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
    return { y: +p.simPosition.y.toFixed(2) };
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
  /* look along the fall line at the brink, from a bit back and above */
  window.__frame = function (x, z, dist = 14, up = 6) {
    const W = c.world, e = 6;
    const gx = (W.heightAt(x + e, z) - W.heightAt(x - e, z)) / (2 * e);
    const gz = (W.heightAt(x, z + e) - W.heightAt(x, z - e)) / (2 * e);
    const m = Math.hypot(gx, gz) || 1;
    const ux = gx / m, uz = gz / m;                     // uphill
    const cam = c.render?.camera || c.camera;
    if (!cam) return null;
    cam.position.set(x - ux * dist, W.heightAt(x, z) + up, z - uz * dist);
    cam.lookAt(x + ux * 2, W.heightAt(x + ux * 2, z + uz * 2), z + uz * 2);
    cam.updateMatrixWorld(true);
    return [+cam.position.x.toFixed(1), +cam.position.y.toFixed(1), +cam.position.z.toFixed(1)];
  };
});

const spots = (process.env.WSPOTS || '313,-276;390,214').split(';').map((s) => s.split(',').map(Number));
for (const [x, z] of spots) {
  await page.evaluate(([a, b]) => window.__place3(a, b), [x, z]);
  await page.waitForTimeout(1200);
  await writeFile(`${OUT}/${TAG}-${x}_${z}-plain.png`, await page.screenshot());
  const n = await page.evaluate(() => window.__paintLip(true));
  await page.waitForTimeout(500);
  await writeFile(`${OUT}/${TAG}-${x}_${z}-magenta.png`, await page.screenshot());
  await page.evaluate(() => window.__paintLip(false));
  console.log(`shot ${x},${z}  (${n} lip meshes painted)`);
}
await browser.close(); server.close();
