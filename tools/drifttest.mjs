#!/usr/bin/env node
/* ============================================================
   drifttest.mjs — "hold forward, go forward."

   THE BUG THIS EXISTS FOR. Movement is camera-relative: wally.js
   builds its stick basis from ctx.camera.getWorldDirection() every
   frame. The follow rig also auto-orbits the boom toward his TRAVEL
   direction — and his travel direction is camera-forward, which the
   lateral framing offsets ~6 deg to the right of the boom azimuth. So
   the orbit chases a target that its own motion pushes away: a
   positive-feedback loop that rotates the basis under a held key and
   turns "forward" into a slow right-hand arc.

   The measurement is the path itself, in world space, never the
   camera: sample x/z at every frame while W is held, take the chord
   heading over an early window and over a late window, and report the
   total bend between them. Straight is < ~3 deg over six seconds.

   Three cases:
     A  hold W for 6 s                     -> path bend must be < 3 deg
     B  hold W, add A at 2.5 s             -> the camera must FOLLOW the
                                              turn, and the path must be
                                              straight again after it
     C  stand still for 2.5 s              -> the idle settle must still
                                              swing the boom to a portrait

     node tools/drifttest.mjs [--verbose]
   ============================================================ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
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

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
/* 16:9 — every RIG constant, the lateral bias included, is tuned there. */
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
let pageErr = null;
page.on('pageerror', (e) => { pageErr = e.message.split('\n')[0]; console.log('PAGEERROR', pageErr); });

await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 60000 });
await page.waitForTimeout(3500);

/* ---------- sampling ----------------------------------------------
   One sample per rendered frame, taken in-page: a round trip per
   sample would alias the very rotation we are trying to measure. */
const startSampling = () => page.evaluate(() => {
  const c = window.WALLY.ctx;
  const f = new c.THREE.Vector3();
  window.__drift = [];
  const t0 = performance.now();
  const tick = () => {
    const w = c.wally;
    if (w?.root) {
      c.camera.getWorldDirection(f);
      const ct = w.controller;
      window.__drift.push({
        t: (performance.now() - t0) / 1000,
        x: w.root.position.x, z: w.root.position.z,
        cam: Math.atan2(f.x, f.z) * 180 / Math.PI,   // basis wally actually uses
        boom: (c.cam?.yaw ?? 0) * 180 / Math.PI,      // the rig's own azimuth
        face: (ct?.yaw ?? 0) * 180 / Math.PI,
        sp: ct ? Math.hypot(ct.velocity.x, ct.velocity.z) : 0,
      });
    }
    window.__driftRAF = requestAnimationFrame(tick);
  };
  tick();
});
const stopSampling = () => page.evaluate(() => {
  cancelAnimationFrame(window.__driftRAF);
  return window.__drift;
});

const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const at = (s, t) => s.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
/** Chord heading of the path between two times, in degrees. */
function heading(s, t0, t1) {
  const a = at(s, t0), b = at(s, t1);
  const dx = b.x - a.x, dz = b.z - a.z;
  if (Math.hypot(dx, dz) < 0.05) return null;   // did not move: no heading
  return Math.atan2(dx, dz) * 180 / Math.PI;
}
function trace(s, label) {
  if (!VERBOSE) return;
  console.log(`   ${label}: t / pathHeading / camYaw / boomYaw / facing / speed`);
  for (let t = 0.5; t <= s[s.length - 1].t - 0.5; t += 1.0) {
    const h = heading(s, t - 0.25, t + 0.25);
    const p = at(s, t);
    console.log(`     ${t.toFixed(1)}s  ${h === null ? '  --  ' : h.toFixed(1).padStart(6)}  ` +
      `${p.cam.toFixed(1).padStart(7)}  ${p.boom.toFixed(1).padStart(7)}  ` +
      `${p.face.toFixed(1).padStart(7)}  ${p.sp.toFixed(2)}`);
  }
}

const results = [];

/* ================================================================
   A — hold W for six seconds. The whole point.
   The first 0.5 s is the acceleration ramp (he is still building
   speed and the springs are still settling), so the START heading is
   measured from 0.5-1.5 s and the END heading from 5.5-6.5 s. Both
   windows are one full second of travel, ~4 m of path each.
   ================================================================ */
console.log('--- A: hold W, six seconds ---');
await startSampling();
await page.keyboard.down('KeyW');
await page.waitForTimeout(7000);
await page.keyboard.up('KeyW');
const A = await stopSampling();
const a0 = heading(A, 0.5, 1.5), a1 = heading(A, 5.5, 6.5);
const aBend = a0 === null || a1 === null ? null : wrap(a1 - a0);
const aCam = wrap(at(A, 6.5).cam - at(A, 0.5).cam);
trace(A, 'A');
console.log(`   path heading  ${a0 === null ? 'n/a' : a0.toFixed(1)} deg -> ${a1 === null ? 'n/a' : a1.toFixed(1)} deg`);
console.log(`   TOTAL PATH BEND  ${aBend === null ? 'n/a' : aBend.toFixed(1)} deg over 6 s   (camera basis moved ${aCam.toFixed(1)} deg)`);
console.log(`   distance travelled ${Math.hypot(at(A, 6.5).x - at(A, 0.5).x, at(A, 6.5).z - at(A, 0.5).z).toFixed(1)} m`);
results.push(['A straight-line bend < 3.0 deg', aBend !== null && Math.abs(aBend) < 3.0,
  aBend === null ? 'he never moved' : `${aBend.toFixed(1)} deg`]);
await page.waitForTimeout(2500);

/* ================================================================
   B — steer mid-walk. Hold W; at 2.5 s add A as well.

   W+A is 45 deg of stick, so the PATH must turn about 45 deg and then
   run straight again. The old rig turned 111 deg and was still turning
   when the clock ran out — the feedback loop, with the stick angle
   itself as the offset it chases.

   What "the camera follows" means here is worth stating, because it is
   not "the boom swings behind him": with a direction held, his facing
   IS camera-forward plus the stick angle, so that gap is 45 deg for as
   long as W+A is held no matter where the boom goes. What must hold is
   that the lens stays locked to his travel (it never decouples or
   spins), and that the orbit is alive again the moment he lets go —
   which is measured on release below and again in case C.
   ================================================================ */
console.log('--- B: hold W, add A at 2.5 s ---');
await startSampling();
await page.keyboard.down('KeyW');
await page.waitForTimeout(2500);
await page.keyboard.down('KeyA');
await page.waitForTimeout(4500);
const bLatchYaw = (await page.evaluate(() => window.WALLY.debug.camInfo())).yaw;
await page.keyboard.up('KeyA');
await page.keyboard.up('KeyW');
await page.waitForTimeout(1300);
const bAfter = await page.evaluate(() => window.WALLY.debug.camInfo());
const B = await stopSampling();
trace(B, 'B');
const bPre = heading(B, 1.0, 2.0);                 // before the steer
const bPost = heading(B, 5.5, 6.5);                // well after it
const bTurn = bPre === null || bPost === null ? null : wrap(bPost - bPre);
/* straightness AFTER the turn has settled */
const bLate0 = heading(B, 5.0, 5.7), bLate1 = heading(B, 6.3, 7.0);
const bLateBend = bLate0 === null || bLate1 === null ? null : wrap(bLate1 - bLate0);
/* the lens vs his travel, while the diagonal is held */
const bLock = Math.abs(wrap(at(B, 6.5).cam - at(B, 6.5).face));
/* the orbit must be alive again once the stick is released */
const bRelease = Math.abs(wrap(bAfter.yaw - bLatchYaw));
console.log(`   path heading ${bPre?.toFixed(1)} -> ${bPost?.toFixed(1)} deg  (turned ${bTurn?.toFixed(1)} deg; W+A is 45 deg of stick)`);
console.log(`   late-path bend ${bLateBend === null ? 'n/a' : bLateBend.toFixed(1)} deg over the last 1.3 s`);
console.log(`   lens sits ${bLock.toFixed(1)} deg off his facing while the diagonal is held (= the stick angle)`);
console.log(`   boom moved ${bRelease.toFixed(1)} deg in the 1.3 s after release (orbit alive again)`);
results.push(['B the turn is the one asked for (25-70 deg, not a spin)',
  bTurn !== null && Math.abs(bTurn) > 25 && Math.abs(bTurn) < 70,
  bTurn === null ? 'no path' : `${bTurn.toFixed(1)} deg`]);
results.push(['B path straight again after the turn (<3.0 deg)',
  bLateBend !== null && Math.abs(bLateBend) < 3.0,
  bLateBend === null ? 'no path' : `${bLateBend.toFixed(1)} deg`]);
results.push(['B lens stays locked to his travel (<60 deg off facing)', bLock < 60, `${bLock.toFixed(1)} deg`]);
results.push(['B orbit resumes on release (>2 deg in 1.3 s)', bRelease > 2, `${bRelease.toFixed(1)} deg`]);

/* ================================================================
   D — the player steering the CAMERA still owns the yaw, latch or no
   latch: WALLY.debug.camSteer() is api.steer(), the same entry point
   the mouse drag and the touch fling spend themselves through.
   ================================================================ */
console.log('--- D: manual steer while W is held ---');
await page.waitForTimeout(2200);
await page.keyboard.down('KeyW');
await page.waitForTimeout(1200);
const d0 = await page.evaluate(() => window.WALLY.debug.camInfo());
await page.evaluate(() => window.WALLY.debug.camSteer(25));
await page.waitForTimeout(400);
const d1 = await page.evaluate(() => window.WALLY.debug.camInfo());
await page.keyboard.up('KeyW');
const dTurn = wrap(d1.yaw - d0.yaw);
console.log(`   boom ${d0.yaw} -> ${d1.yaw} deg  (asked for +25)`);
results.push(['D manual steer still turns the boom (20-30 deg)',
  Math.abs(dTurn) > 20 && Math.abs(dTurn) < 30, `${dTurn.toFixed(1)} deg`]);

/* ================================================================
   C — the idle settle must survive. Stand still: after portraitDelay
   the boom swings to the three-quarter portrait (RIG.portraitBias,
   134 deg off his facing, either hand).
   ================================================================ */
console.log('--- C: stand still, the boom must settle to a portrait ---');
const off = async () => page.evaluate(() => {
  const c = window.WALLY.ctx;
  const d = c.cam.yaw * 180 / Math.PI - (c.wally.controller?.yaw ?? 0) * 180 / Math.PI;
  return Math.abs(((((d) + 180) % 360 + 360) % 360) - 180);
});
const cStart = await off();
const cTrack = [];
for (let i = 0; i < 6; i++) { await page.waitForTimeout(1000); cTrack.push(await off()); }
const cEnd = cTrack[cTrack.length - 1];
console.log(`   boom off his facing: ${cStart.toFixed(0)} -> ${cTrack.map((v) => v.toFixed(0)).join(' -> ')} deg`);
console.log(`   (0 = on his tail, RIG.portraitBias = 134 = the three-quarter front)`);
results.push(['C idle settle swings the boom round to his face (>100 deg off)',
  cEnd > 100, `${cEnd.toFixed(1)} deg`]);
results.push(['C and it is inside the portrait window (104-164 deg)',
  cEnd > 104 && cEnd < 164, `${cEnd.toFixed(1)} deg`]);

results.push(['no page errors', pageErr === null, pageErr || 'clean']);

console.log('');
let ok = true;
for (const [name, pass, detail] of results) {
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  [${detail}]`);
}
console.log(ok ? '\nPASS — holding forward goes forward' : '\nFAIL — the basis is still rotating under the player');

await browser.close();
server.close();
process.exit(ok ? 0 : 1);
