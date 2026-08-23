/* _vk-park2.mjs — the parked machine on FLAT ground, walked around,
   photographed from the follow camera at four angles, and measured at
   each wheel's own contact point (the first pass measured every wheel
   against the height under the FRAME ORIGIN, which on a hillside is a
   different height, and reported a buried bicycle that was really an
   unconformed slope). node tools/_vk-park2.mjs <ride> <prefix>
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const RIDE = process.argv[2] || 'bike';
const PRE = process.argv[3] || '/tmp/vk-park2';

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

const setup = await page.evaluate((ride) => {
  const c = window.WALLY.ctx, w = c.wally;
  const cy = c.world && (c.world.city || c.city);
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  const ps = c.game.places({ all: true });
  let best = null;
  for (const p of ps) {
    const v = cy && cy.doorPosition ? cy.doorPosition(p.id) : null;
    if (!v) continue;
    /* flatness over the 4 m the machine and rider occupy */
    let lo = 1e9, hi = -1e9, ok = true;
    for (const [dx, dz] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, -2]]) {
      const h = H(v.x + dx, v.z + dz);
      if (h == null) { ok = false; break; }
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (!ok) continue;
    const range = hi - lo;
    if (!best || range < best.range) best = { id: p.id, x: v.x, y: v.y, z: v.z, range: +range.toFixed(3) };
  }
  if (!best) return { ok: false };
  const sx = best.x + 6.5, sz = best.z;
  const h = H(sx, sz) ?? 0;
  w.setPosition(sx, h, sz);
  const yaw = Math.atan2(best.x - sx, best.z - sz);
  if (w.controller) w.controller.yaw = yaw;
  w.root.rotation.y = yaw;
  c.game.actions.grantRide(ride);
  c.game.actions.equipRide(ride);
  return { ok: true, door: best };
}, RIDE);
console.error('SETUP ' + JSON.stringify(setup));
await page.waitForTimeout(2500);
/* RIDE TO THE DOOR WITH THE KEYS, and pick the key by the CAMERA, not
   by his facing: WASD is camera-relative (wally.camRelative), so after a
   teleport the key that points at the door is whichever one the camera
   says it is. Steer every 250 ms until he is at the doorstep. */
const door = setup.door;
for (let step = 0; step < 26; step++) {
  const s = await page.evaluate((d) => {
    const c = window.WALLY.ctx, w = c.wally;
    const p = w.root.position;
    const dx = d.x - p.x, dz = d.z - p.z;
    const dist = Math.hypot(dx, dz);
    const f = new window.WALLY.THREE.Vector3();
    c.camera.getWorldDirection(f); f.y = 0; f.normalize();
    const rx = -f.z, rz = f.x;                    // camera right
    return { dist, fwd: (dx * f.x + dz * f.z) / (dist || 1), right: (dx * rx + dz * rz) / (dist || 1) };
  }, door);
  if (s.dist < 2.6) break;
  const ks = [];
  if (s.fwd > 0.35) ks.push('KeyW'); else if (s.fwd < -0.35) ks.push('KeyS');
  if (s.right > 0.35) ks.push('KeyD'); else if (s.right < -0.35) ks.push('KeyA');
  if (!ks.length) ks.push('KeyW');
  for (const k of ks) await page.keyboard.down(k);
  await page.waitForTimeout(250);
  for (const k of ks) await page.keyboard.up(k);
}
await page.waitForTimeout(900);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(2600);
await page.screenshot({ path: PRE + '-a.png' });

const geom = await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE, w = c.wally, b = w.bike;
  if (!b) return { err: 'no prop' };
  const g = b.group; g.updateMatrixWorld(true);
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  const V = new T.Vector3();
  const contact = (o) => {                       // lowest world point of o, brute force over its geometry
    let best = null;
    o.traverse((m) => {
      if (!m.isMesh || !m.geometry || !m.geometry.attributes.position) return;
      const p = m.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        V.fromBufferAttribute(p, i); m.localToWorld(V);
        if (!best || V.y < best[1]) best = [V.x, V.y, V.z];
      }
    });
    return best;
  };
  const out = { parent: g.parent === c.scene ? 'scene' : 'root', rotZ: +g.rotation.z.toFixed(4),
    pos: [+g.position.x.toFixed(3), +g.position.y.toFixed(3), +g.position.z.toFixed(3)],
    standVisible: b.stand ? b.stand.visible : null,
    riderDist: +Math.hypot(w.root.position.x - g.position.x, w.root.position.z - g.position.z).toFixed(3) };
  const parts = [];
  b.wheels.forEach((wh, i) => { const p = contact(wh); parts.push({ what: 'wheel' + i, p: p.map((v) => +v.toFixed(4)), groundHere: +H(p[0], p[2]).toFixed(4), clearance: +(p[1] - H(p[0], p[2])).toFixed(4) }); });
  if (b.stand) { const p = contact(b.stand); parts.push({ what: 'stand', p: p.map((v) => +v.toFixed(4)), groundHere: +H(p[0], p[2]).toFixed(4), clearance: +(p[1] - H(p[0], p[2])).toFixed(4) }); }
  out.contacts = parts;
  return out;
});
console.error('GEOM ' + JSON.stringify(geom));

/* walk a lap of it, follow camera, four sides */
const keys = [['KeyA', 900], ['KeyS', 900], ['KeyD', 1400], ['KeyW', 700]];
let i = 0;
for (const [k, ms] of keys) {
  await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k);
  await page.waitForTimeout(1100);
  await page.screenshot({ path: `${PRE}-lap${++i}.png` });
}
console.error('ERRS ' + JSON.stringify(errs.slice(0, 5)));
await browser.close();
server.close();
