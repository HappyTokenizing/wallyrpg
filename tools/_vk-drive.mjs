/* _vk-drive.mjs — INDEPENDENT drivetrain ruler (verify judge, round 7).

   Does NOT use WALLY.debug.driveTrace. Nothing is phase-locked. The
   machine is granted and equipped through ctx.game.actions, then driven
   with a HELD KEY, and every quantity is read off the live scene graph
   after lateUpdate. Distance is the controller's own simPosition delta;
   rotation is the raw wheel angle, unwrapped here, by me.

     node tools/_vk-drive.mjs <ride> <mode> <secs> <out.json>
       mode: cruise | sprint | stick:<0..1> | coast | park | none
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const RIDE = process.argv[2] || 'bike';
const MODE = process.argv[3] || 'cruise';
const SECS = +(process.argv[4] || 6);
const OUT = process.argv[5] || null;

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
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

const TOUCH = MODE.startsWith('rung:');
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro${TOUCH ? '&touch=1' : ''}`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);

/* put a real, owned, equipped machine under him, the game's own path */
const mount = await page.evaluate((ride) => {
  const c = window.WALLY.ctx;
  const a = c.game && c.game.actions;
  let how = 'none';
  try {
    if (a && a.grantRide) { a.grantRide(ride); how = 'grantRide'; }
    if (a && a.equipRide) { a.equipRide(ride); how += '+equipRide'; }
  } catch (e) { how = 'threw ' + e.message; }
  return { how, state: c.wally.bikeState };
}, RIDE);
await page.waitForTimeout(2000);

/* sampler, installed as the LAST lateUpdate handle */
await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const T = window.WALLY.THREE;
  const w = c.wally;
  const root = w.root;
  const ctrl = w.controller;
  const rows = [];
  const inv = new T.Matrix4();
  const V = new T.Vector3();
  const loc = (o, x, y, z) => { V.set(x || 0, y || 0, z || 0); o.localToWorld(V); V.applyMatrix4(inv); return [+V.x.toFixed(5), +V.y.toFixed(5), +V.z.toFixed(5)]; };

  window.__VK = {
    rows, on: false,
    start() { rows.length = 0; this.on = true; },
    stop() { this.on = false; return rows; },
  };

  c._handles.push({
    lateUpdate() {
      const S = window.__VK;
      if (!S.on) return;
      const b = w.bike;
      root.updateMatrixWorld(true);
      inv.copy(root.matrixWorld).invert();
      const p = ctrl ? ctrl.simPosition : root.position;
      const f = new T.Vector3(0, 0, 1).applyQuaternion(root.quaternion);
      const r = {
        t: c.elapsed,
        px: p.x, py: p.y, pz: p.z,
        spd: ctrl ? ctrl.planarSpeed : 0,
        yaw: root.rotation.y,
        fwd: [+f.x.toFixed(5), +f.y.toFixed(5), +f.z.toFixed(5)],
        rx: root.position.x, rz: root.position.z,
        phase: w.bikeState.phase, ride: w.bikeState.ride, id: w.bikeState.id,
        lean: w.bikeState.lean,
      };
      const an = w.animator;
      if (an) {
        r.clipA = an._bkA && an._bkA.__name; r.clipB = an._bkB && an._bkB.__name;
        r.bkF = an._bkF; r.bikeW = an.bikeW; r.locPhase = an.locPhase;
        r.bikePhaseA = an.bikePhase; r.locoCycle = an.locoCycle;
      }
      if (b) {
        r.vis = b.group.visible;
        r.grotz = b.group.rotation.z;
        r.gpar = b.group.parent ? (b.group.parent === root ? 'root' : (b.group.parent === c.scene ? 'scene' : 'other')) : 'none';
        r.gpos = [+b.group.position.x.toFixed(4), +b.group.position.y.toFixed(4), +b.group.position.z.toFixed(4)];
        r.stand = b.stand ? b.stand.visible : null;
        r.odo = typeof b.odometer === 'number' ? b.odometer : null;
        r.wrot = b.wheels.map((x) => x.rotation.x);
        r.wr = b.wheels.map((x) => +x.position.y.toFixed(5));
        r.wz = b.wheels.map((x) => +x.position.z.toFixed(4));
        r.crot = b.crank ? b.crank.rotation.x : null;
        /* material points, root-local: rear rim top marker, left pedal plate, ankles */
        const rear = b.wheels.find((x) => x.position.z < 0) || b.wheels[0];
        const front = b.wheels.find((x) => x.position.z > 0) || b.wheels[1];
        if (rear) r.rimR = loc(rear, 0, rear.position.y * 0.92, 0);
        if (front) r.rimF = loc(front, 0, front.position.y * 0.92, 0);
        if (b.crank) {
          let arm = null, plate = null;
          for (const ch of b.crank.children) if (!ch.isMesh && ch.position.x > 0) arm = ch;
          if (arm) { plate = arm.children.find((x) => x.isMesh && x.geometry && x.geometry.type === 'BoxGeometry') || arm.children.find((x) => x.isMesh); r.crankTip = loc(arm, 0, -0.078, 0); }
          if (plate) r.pedalL = loc(plate, 0, 0, 0);
        }
      }
      r.ankL = loc(w.bones.footL, 0, 0, 0);
      r.ankR = loc(w.bones.footR, 0, 0, 0);
      rows.push(r);
    },
  });
  /* clip names, so the ladder rung is identifiable */
  try {
    const A = window.WALLY.ctx.wally.animator;
  } catch (e) {}
  return true;
});

/* name the clips so the sampler can report the rung */
await page.evaluate(() => {
  const w = window.WALLY.ctx.wally;
  const an = w.animator;
  if (!an) return false;
  const C = an.constructor && an.constructor.CLIPS;
  return true;
});

async function hold(mods, secs) {
  for (const k of mods) await page.keyboard.down(k);
  await page.waitForTimeout(secs * 1000);
  for (const k of mods) await page.keyboard.up(k);
}

await page.evaluate(() => window.__VK.start());
if (MODE === 'cruise') { await hold(['KeyW'], SECS); await page.waitForTimeout(2500); }
else if (MODE === 'sprint') { await hold(['ShiftLeft', 'KeyW'], SECS); await page.waitForTimeout(2500); }
else if (MODE.startsWith('stick:')) {
  const mag = +MODE.split(':')[1];
  await page.evaluate((m) => {
    const w = window.WALLY.ctx.wally;
    w.setInput(() => ({ x: 0, z: m, jump: false, jumpHeld: false, run: false }));
  }, mag);
  await page.waitForTimeout(SECS * 1000);
  await page.evaluate(() => window.WALLY.ctx.wally.setInput(null));
  await page.waitForTimeout(1500);
} else if (MODE.startsWith('rung:')) {
  /* THE REAL UI, held: the touch thumbstick, pushed to the exact
     deflection whose analogue speed is this ladder rung. touch.js:
     speed = walk*(t/RUN_AT) below RUN_AT, walk+(run-walk)*((t-RUN_AT)/(1-RUN_AT))
     above; and t = (u-DEAD)/(1-DEAD) with u = len/R. */
  const want = +MODE.split(':')[1];
  const geo = await page.evaluate(() => {
    const t = window.WALLY.ctx.ui && window.WALLY.ctx.ui.touch;
    const z = document.querySelector(".w-stickzone") || document.querySelector('[class*=zone]');
    const r = z ? z.getBoundingClientRect() : null;
    const c = window.WALLY.ctx.wally.controller.opts;
    return { axes: t && t.axes ? t.axes : null, enabled: t ? t.enabled : null,
      rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      walk: c.walkSpeed, run: c.runSpeed };
  });
  const R = (geo.axes && geo.axes.R) || 40;
  const DEAD = 0.12, RUN_AT = 0.62;
  const t = want <= geo.walk ? RUN_AT * (want / geo.walk)
    : RUN_AT + (1 - RUN_AT) * ((want - geo.walk) / (geo.run - geo.walk));
  const u = DEAD + t * (1 - DEAD);
  const len = u * R;
  const cx = geo.rect ? geo.rect.x + Math.min(geo.rect.w * 0.5, 110) : 110;
  const cy = geo.rect ? geo.rect.y + geo.rect.h - 110 : 500;
  console.error(`[vk] rung ${want} m/s -> stick t=${t.toFixed(3)} u=${u.toFixed(3)} len=${len.toFixed(1)}px R=${R} geo=${JSON.stringify(geo)}`);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 2);
  await page.mouse.move(cx, cy - len * 0.5);
  await page.mouse.move(cx, cy - len);
  await page.waitForTimeout(300);
  const got = await page.evaluate(() => {
    const t2 = window.WALLY.ctx.ui.touch;
    return t2 && t2.axes ? t2.axes : null;
  });
  console.error(`[vk] stick reads ${JSON.stringify(got)}`);
  await page.waitForTimeout(SECS * 1000);
  await page.mouse.up();
  await page.waitForTimeout(1200);
} else if (MODE === 'coast') { await hold(['KeyW'], 2.0); await page.waitForTimeout(SECS * 1000); }
else if (MODE === 'park') {
  await hold(['KeyW'], 2.0);
  await page.evaluate(() => { window.WALLY.ctx.game.actions.equipRide(null); });
  await page.waitForTimeout(SECS * 1000);
} else { await page.waitForTimeout(SECS * 1000); }

const rows = await page.evaluate(() => window.__VK.stop());
const dbg = await page.evaluate(() => {
  const w = window.WALLY.ctx.wally;
  const b = w.bike;
  return {
    state: w.bikeState, riding: w.riding, rideId: w.rideId,
    hasCrank: !!(b && b.crank), radii: b && b.wheelRadii ? b.wheelRadii : null,
    R: b ? b.R : null, odo: b && typeof b.odometer === 'number' ? b.odometer : null,
    parkLean: b ? b.parkLean : null,
  };
});
const out = { ride: RIDE, mode: MODE, secs: SECS, mount, dbg, errs, n: rows.length, rows };
if (OUT) await writeFile(OUT, JSON.stringify(out));
else console.log(JSON.stringify(out));
console.error(`[vk] ${RIDE}/${MODE}: ${rows.length} rows, errs=${errs.length}`);

await browser.close();
server.close();
