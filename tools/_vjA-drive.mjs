/* _vjA-drive.mjs — INDEPENDENT drivetrain ruler, written by the verify judge.
   Does not use WALLY.debug.driveTrace. Nothing is phase-locked: the
   character is granted and equipped a real bicycle through ctx.game,
   then driven with a held W key, and every quantity is sampled off the
   live scene graph AFTER lateUpdate, in world space, then expressed in
   the root's own frame.  Direction of travel is measured, never assumed.

   node tools/_vjA-drive.mjs [rideId] [seconds]
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const RIDE = process.argv[2] || 'bike';
const SECS = +(process.argv[3] || 5);
const MODE = process.argv[4] || 'cruise';

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
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));

await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);

if (MODE === 'mount') await page.evaluate(() => { window.__NOEQUIP = true; });
/* ---- put a real, owned, equipped machine under him (the game's path) ---- */
const mount = await page.evaluate((ride) => {
  const c = window.WALLY.ctx;
  const g = c.game;
  const a = g && g.actions;
  let how = 'none';
  try {
    if (a && a.grantRide) { a.grantRide(ride); how = 'grantRide'; }
    if (a && a.equipRide && !window.__NOEQUIP) { a.equipRide(ride); how += '+equipRide'; }
  } catch (e) { how = 'threw ' + e.message; }
  return { how, state: c.wally.bikeState };
}, RIDE);

await page.waitForTimeout(1800);

/* ---- install the sampler as the LAST lateUpdate handle ---- */
await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const T = window.WALLY.THREE;
  const w = c.wally;
  const root = w.root;
  const rows = [];
  const inv = new T.Matrix4();
  const V = new T.Vector3();

  const pick = () => {
    const b = w.bike;
    if (!b) return null;
    /* the LEFT crank arm is the child group at +x (bike.js: left is +x) */
    let arm = null, plate = null;
    if (b.crank) {
      for (const ch of b.crank.children) {
        if (!ch.isMesh && ch.position.x > 0) arm = ch;
      }
      if (arm) for (const ch of arm.children) if (ch.isMesh && ch.geometry?.type === 'BoxGeometry') plate = ch;
    }
    const rear = b.wheels ? (b.wheels.find((x) => x.position.z < 0) || b.wheels[0]) : null;
    const front = b.wheels ? (b.wheels.find((x) => x.position.z > 0) || b.wheels[1]) : null;
    return { b, arm, plate, rear, front };
  };

  const loc = (o, x, y, z) => {
    V.set(x || 0, y || 0, z || 0);
    o.localToWorld(V);
    V.applyMatrix4(inv);
    return [+V.x.toFixed(5), +V.y.toFixed(5), +V.z.toFixed(5)];
  };
  const wld = (o, x, y, z) => {
    V.set(x || 0, y || 0, z || 0);
    o.localToWorld(V);
    return [+V.x.toFixed(5), +V.y.toFixed(5), +V.z.toFixed(5)];
  };

  window.__DRV = {
    rows,
    on: false,
    start() { rows.length = 0; this.on = true; },
    stop() { this.on = false; return rows; },
  };

  c._handles.push({
    lateUpdate() {
      const S = window.__DRV;
      if (!S.on) return;
      const P = pick();
      root.updateMatrixWorld(true);
      inv.copy(root.matrixWorld).invert();
      const an = w.anim || null;
      const r = {
        t: c.elapsed,
        rootPos: [root.position.x, root.position.y, root.position.z],
        rootYaw: root.rotation.y,
        fwd: (() => { const f = new T.Vector3(0, 0, 1).applyQuaternion(root.quaternion); return [f.x, f.y, f.z]; })(),
        ankleL: loc(w.bones.footL, 0, 0, 0),
        ankleR: loc(w.bones.footR, 0, 0, 0),
        ankleLW: wld(w.bones.footL, 0, 0, 0),
      };
      { const bs = w.bikeState; r.rideW = bs.ride; r.phase = bs.phase; r.lean = bs.lean; }
      if (P && P.b) {
        /* material point at the tip of the LEFT crank arm (arm-local -y) */
        if (P.arm) r.crankTip = loc(P.arm, 0, -0.078, 0);
        if (P.plate) r.pedalL = loc(P.plate, 0, 0, 0);
        /* material point on the rear rim: wheel-local +y at rim radius */
        if (P.rear) r.rimR = loc(P.rear, 0, 0.103, 0);
        if (P.front) r.rimF = loc(P.front, 0, 0.103, 0);
        r.crankRot = P.b.crank ? P.b.crank.rotation.x : null;
        r.wheelRot = P.rear ? P.rear.rotation.x : null;
        r.bikeVisible = P.b.group.visible;
        r.standVisible = P.b.stand ? P.b.stand.visible : null;
        r.groupRotZ = P.b.group.rotation.z;
      }
      rows.push(r);
    },
  });
  return true;
});

await page.evaluate(() => window.__DRV.start());
if (MODE === 'sprint') {
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(SECS * 1000);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
} else if (MODE === 'coast') {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(SECS * 1000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(3000);
} else if (MODE === 'mount') {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.evaluate((r) => { window.WALLY.ctx.game.actions.equipRide(r); }, RIDE);
  await page.waitForTimeout(3500);
  await page.keyboard.up('KeyW');
} else if (MODE === 'dismount') {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2000);
  await page.evaluate(() => { window.WALLY.ctx.game.actions.equipRide(null); });
  await page.waitForTimeout(3000);
  await page.keyboard.up('KeyW');
} else {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(SECS * 1000);
  await page.keyboard.up('KeyW');
}
const rows = await page.evaluate(() => window.__DRV.stop());
const dbg = await page.evaluate(() => {
  const w = window.WALLY.ctx.wally;
  return { state: w.bikeState, riding: w.riding, rideId: w.rideId, hasCrank: !!(w.bike && w.bike.crank) };
});
console.log(JSON.stringify({ mount, mode: MODE, errs, dbg, n: rows.length, rows }, null, 0));

await browser.close();
server.close();
