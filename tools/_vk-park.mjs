/* _vk-park.mjs — judge the parked machine. Rides it to a real door,
   dismounts through the game's own unequip, then (a) measures the pose
   against the ground with the geometry, not the eye, and (b) photographs
   it from the FOLLOW camera, which is the only camera a player has.

   node tools/_vk-park.mjs <ride> <outPrefix>
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const RIDE = process.argv[2] || 'bike';
const PRE = process.argv[3] || '/tmp/vk-park';

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

const doors = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const out = { places: null, door: null };
  try {
    const ps = c.game.places({ all: true });
    out.places = ps.slice(0, 40).map((p) => ({ id: p.id, name: p.name, x: p.x, z: p.z, pos: p.position ? [p.position.x, p.position.y, p.position.z] : null }));
  } catch (e) { out.places = 'threw ' + e.message; }
  try {
    const cy = c.world && (c.world.city || c.city);
    if (cy && cy.doorPosition) {
      const list = [];
      for (const p of (out.places || [])) {
        const v = cy.doorPosition(p.id);
        if (v) list.push({ id: p.id, name: p.name, d: [v.x, v.y, v.z] });
      }
      out.door = list;
    } else out.door = 'no doorPosition (' + Object.keys(c.world || {}).join(',') + ')';
  } catch (e) { out.door = 'threw ' + e.message; }
  return out;
});
console.error(JSON.stringify(doors).slice(0, 2400));

/* stand him a few metres out from a door, facing it, then ride in */
const setup = await page.evaluate((ride) => {
  const c = window.WALLY.ctx;
  const w = c.wally;
  const cy = c.world && (c.world.city || c.city);
  let door = null, id = null;
  const ps = c.game.places({ all: true });
  for (const p of ps) {
    const v = cy && cy.doorPosition ? cy.doorPosition(p.id) : null;
    if (v && Number.isFinite(v.x)) { door = { x: v.x, y: v.y, z: v.z }; id = p.id; break; }
  }
  if (!door) return { ok: false };
  /* 7 m out from the door along +x, facing it */
  const sx = door.x + 7, sz = door.z;
  const h = c.world.heightAt ? c.world.heightAt(sx, sz) : 0;
  w.setPosition(sx, h, sz);
  if (w.controller) w.controller.yaw = Math.atan2(door.x - sx, door.z - sz);
  w.root.rotation.y = Math.atan2(door.x - sx, door.z - sz);
  c.game.actions.grantRide(ride);
  c.game.actions.equipRide(ride);
  return { ok: true, id, door, start: [sx, h, sz] };
}, RIDE);
console.error('setup ' + JSON.stringify(setup));
await page.waitForTimeout(2500);

/* ride the last few metres for real */
await page.keyboard.down('KeyW');
await page.waitForTimeout(1300);
await page.keyboard.up('KeyW');
await page.waitForTimeout(600);
await page.screenshot({ path: PRE + '-1-riding.png' });

/* the game's only dismount */
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(2500);
await page.screenshot({ path: PRE + '-2-parked.png' });

/* measure the parked pose against the ground, with the geometry */
const geom = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const T = window.WALLY.THREE;
  const w = c.wally;
  const b = w.bike;
  if (!b) return { err: 'no prop' };
  const g = b.group;
  g.updateMatrixWorld(true);
  const box = new T.Box3();
  const lowest = (o) => { box.setFromObject(o); return { min: box.min.y, max: box.max.y, cx: (box.min.x + box.max.x) / 2, cz: (box.min.z + box.max.z) / 2 }; };
  let gy = 0;
  try { const h = c.world.heightAt ? c.world.heightAt(g.position.x, g.position.z) : null; if (Number.isFinite(h)) gy = h; } catch (e) {}
  const out = {
    parent: g.parent === c.scene ? 'scene' : (g.parent === w.root ? 'root' : 'other'),
    visible: g.visible, rotZ: +g.rotation.z.toFixed(4), rotY: +g.rotation.y.toFixed(4),
    pos: [+g.position.x.toFixed(3), +g.position.y.toFixed(3), +g.position.z.toFixed(3)],
    groundY: +gy.toFixed(3),
    standVisible: b.stand ? b.stand.visible : null,
    rider: { pos: [+w.root.position.x.toFixed(3), +w.root.position.y.toFixed(3), +w.root.position.z.toFixed(3)], riding: w.riding, state: w.bikeState },
    dist: +Math.hypot(w.root.position.x - g.position.x, w.root.position.z - g.position.z).toFixed(3),
  };
  if (b.stand) { const s = lowest(b.stand); out.standFoot = { worldMinY: +s.min.toFixed(4), aboveGround: +(s.min - gy).toFixed(4), x: +s.cx.toFixed(3), z: +s.cz.toFixed(3) }; }
  out.wheels = b.wheels.map((wh) => { const s = lowest(wh); return { worldMinY: +s.min.toFixed(4), aboveGround: +(s.min - gy).toFixed(4) }; });
  const wholeBox = new T.Box3().setFromObject(g);
  out.propBox = { minY: +wholeBox.min.y.toFixed(4), maxY: +wholeBox.max.y.toFixed(4), aboveGround: +(wholeBox.min.y - gy).toFixed(4) };
  out.cam = { mode: c.cam && c.cam.mode, pos: [+c.camera.position.x.toFixed(2), +c.camera.position.y.toFixed(2), +c.camera.position.z.toFixed(2)] };
  return out;
});
console.error('PARKGEOM ' + JSON.stringify(geom));

/* walk away and look back — the follow camera at a few metres */
await page.keyboard.down('KeyS');
await page.waitForTimeout(1400);
await page.keyboard.up('KeyS');
await page.waitForTimeout(1400);
await page.screenshot({ path: PRE + '-3-walkaway.png' });
await page.keyboard.down('KeyA');
await page.waitForTimeout(900);
await page.keyboard.up('KeyA');
await page.waitForTimeout(1200);
await page.screenshot({ path: PRE + '-4-side.png' });

/* remount: does it come back under him */
await page.evaluate((r) => window.WALLY.ctx.game.actions.equipRide(r), RIDE);
await page.waitForTimeout(2500);
const back = await page.evaluate(() => {
  const c = window.WALLY.ctx; const w = c.wally; const b = w.bike;
  return { parent: b.group.parent === w.root ? 'root' : 'other', pos: [b.group.position.x, b.group.position.y, b.group.position.z],
    rotZ: b.group.rotation.z, stand: b.stand ? b.stand.visible : null, riding: w.riding, state: w.bikeState };
});
await page.screenshot({ path: PRE + '-5-remount.png' });
console.error('REMOUNT ' + JSON.stringify(back));
console.error('ERRS ' + JSON.stringify(errs.slice(0, 6)));
await browser.close();
server.close();
