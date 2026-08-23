/* _wk-ruler.mjs — driveTrace at the rung it lied about, cross-checked
   against an INDEPENDENT measurement that shares none of its machinery:
   drive the game's own frame loop with a real held key, sample the
   wheel angle and the controller position off the live scene, and
   compute revolutions per metre from those two series alone.

   node tools/_wk-ruler.mjs [ride] [rung]
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const RIDE = process.argv[2] || 'bike';
const RUNG = +(process.argv[3] || 8.2);

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

/* 1. AT THE DOOR — the spot the judge measured at, where the plateau
      detector broke out early. */
await page.evaluate((ride) => {
  const c = window.WALLY.ctx, w = c.wally;
  const cy = c.world.city || c.city;
  const v = cy.doorPosition('apartment');
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : 0; } catch (e) { return 0; } };
  w.setPosition(v.x + 2, H(v.x + 2, v.z + 1), v.z + 1);
  c.game.actions.grantRide(ride);
  c.game.actions.equipRide(ride);
}, RIDE);
await page.waitForTimeout(2600);

const atDoor = await page.evaluate(([ride, rung]) => {
  const t = window.WALLY.debug.driveTrace(ride, rung, 32);
  return { rungRequested: t.rungRequested, rungTarget: t.rungTarget, rungMeasured: t.rungMeasured,
    warmFrames: t.warmFrames, warmSpeed: t.warmSpeed, sampledAtCruise: t.sampledAtCruise,
    sampleSpeedDriftPct: t.sampleSpeedDriftPct, travelBlocked: t.travelBlocked,
    travelAlongOwnForward: t.travelAlongOwnForward, travelExpected: t.travelExpected,
    metresTravelled: t.metresTravelled, wheelRateErrPct: t.wheelRateErrPct,
    maxBackwardStepRad: t.maxBackwardStepRad };
}, [RIDE, RUNG]);
console.error('atDoor ' + JSON.stringify(atDoor));

/* 2. ON THE RUNWAY — 120 m of clear ground, found by DRIVING it
      (tools/_vjJ/p4b-site.mjs). The door site above is boxed in by a
      wall 20 m down every heading, which is exactly the condition
      travelBlocked exists to announce. */
const RUNWAY = { x: 332.55, z: -253.73, yaw: -1.571 };
await page.evaluate((q) => {
  const c = window.WALLY.ctx;
  c.wally.setPosition(q.x, c.world.heightAt(q.x, q.z), q.z);
  c.wally.setYaw(q.yaw);
  if (c.wally.controller) c.wally.controller.velocity.set(0, 0, 0);
}, RUNWAY);
await page.waitForTimeout(1800);

const onRunway = await page.evaluate(([ride, rung]) => {
  const t = window.WALLY.debug.driveTrace(ride, rung, 32);
  return { rungRequested: t.rungRequested, rungTarget: t.rungTarget, rungMeasured: t.rungMeasured,
    warmFrames: t.warmFrames, warmSpeed: t.warmSpeed, sampledAtCruise: t.sampledAtCruise,
    sampleSpeedDriftPct: t.sampleSpeedDriftPct, travelBlocked: t.travelBlocked,
    travelAlongOwnForward: t.travelAlongOwnForward, travelExpected: t.travelExpected,
    metresTravelled: t.metresTravelled, wheelRateErrPct: t.wheelRateErrPct,
    revPerMetreDemanded: t.revPerMetreDemanded, revPerMetreDelivered: t.revPerMetreDelivered,
    maxBackwardStepRad: t.maxBackwardStepRad };
}, [RIDE, RUNG]);
console.error('onRunway ' + JSON.stringify(onRunway));

/* 3. THE INDEPENDENT RULER. Hold Shift+W for real, let the game's own
      rAF loop run, and sample (wheel angle, controller position) off the
      live scene once a frame. Nothing here calls driveTrace, steps the
      controller by hand, or reads a clip. */
await page.evaluate(() => { window.WALLY.debug.locomotion(null); });
await page.mouse.click(640, 400);
/* W IS A CAMERA-RELATIVE WISH — camera.js builds controller.input from
   the camera basis — so the heading he takes is the follow rig's, not
   any yaw set above, and a spot that is clear along one heading is not
   clear along that one. Rather than hunt for a runway, sample the WHOLE
   run and then keep only the longest window of frames all within 0.2%
   of the top speed. A rate taken while accelerating, or after he has
   found a wall, is not a rate. */
await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const rows = [];
  window.__WK = { rows, on: false, start() { rows.length = 0; this.on = true; }, stop() { this.on = false; return rows; } };
  c._handles.push({ lateUpdate() {
    const S = window.__WK; if (!S.on) return;
    const w = c.wally, b = w.bike, ct = w.controller;
    if (!b || !ct) return;
    rows.push({ x: ct.simPosition.x, z: ct.simPosition.z, spd: ct.planarSpeed,
      wrot: b.wheels[0].rotation.x, wr: b.wheels[0].position.y });
  } });
});
await page.evaluate((q) => {
  const c = window.WALLY.ctx;
  c.wally.setPosition(q.x, c.world.heightAt(q.x, q.z), q.z);
  c.wally.setYaw(q.yaw);
  if (c.wally.controller) c.wally.controller.velocity.set(0, 0, 0);
}, RUNWAY);
await page.waitForTimeout(1400);
await page.evaluate(() => window.__WK.start());
await page.keyboard.down('ShiftLeft');
await page.keyboard.down('KeyW');
await page.waitForTimeout(8000);
const rows = await page.evaluate(() => window.__WK.stop());
await page.keyboard.up('KeyW');
await page.keyboard.up('ShiftLeft');

const TAU = Math.PI * 2;
const indep = (() => {
  if (rows.length < 30) return { err: 'no rows' };
  const sp = rows.map((r) => r.spd);
  const top = sp.slice().sort((a2, b2) => b2 - a2)[Math.floor(rows.length * 0.05)];
  let bi = 0, bl = 0, i = 0;
  while (i < rows.length) {
    if (Math.abs(sp[i] - top) <= top * 0.008) {
      let j = i; while (j < rows.length && Math.abs(sp[j] - top) <= top * 0.008) j++;
      if (j - i > bl) { bl = j - i; bi = i; }
      i = j;
    } else i++;
  }
  const R = rows.slice(bi, bi + bl);
  if (R.length < 20) return { err: 'never settled', top: +top.toFixed(3), best: bl };
  let dist = 0;
  for (let k = 1; k < R.length; k++) dist += Math.hypot(R[k].x - R[k - 1].x, R[k].z - R[k - 1].z);
  let rad = 0, back = 0;
  for (let k = 1; k < R.length; k++) {
    let d = R[k].wrot - R[k - 1].wrot;
    d -= Math.round(d / TAU) * TAU;
    if (d < back) back = d;
    rad += d;
  }
  const r0 = R[0].wr;
  const dem = 1 / (TAU * r0), del = (rad / TAU) / dist;
  return { steadyFrames: R.length, ofTotal: rows.length, cruiseSpeed: +top.toFixed(4),
    metres: +dist.toFixed(4), wheelRevs: +(rad / TAU).toFixed(4), wheelRadius: +r0.toFixed(4),
    speedDriftPct: +(Math.abs(R[R.length - 1].spd - R[0].spd) / top * 100).toFixed(4),
    revPerMetreDemanded: +dem.toFixed(4), revPerMetreDelivered: +del.toFixed(4),
    wheelRateErrPct: +((del / dem - 1) * 100).toFixed(4),
    maxBackwardStepRad: +back.toFixed(5) };
})();
console.error('independent ' + JSON.stringify(indep));
console.error('ERRS ' + JSON.stringify(errs.slice(0, 5)));
await browser.close();
server.close();
