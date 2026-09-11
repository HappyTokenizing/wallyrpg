#!/usr/bin/env node
/* ============================================================
   drifttest.mjs — "hold forward, go forward.
                    and the camera does not move unless you move it."

   THE BUG THIS EXISTED FOR. Movement is camera-relative: wally.js
   builds its stick basis from ctx.camera.getWorldDirection() every
   frame. The follow rig used to auto-orbit the boom toward his TRAVEL
   direction — and his travel direction is camera-forward, which the
   lateral framing offset ~6 deg from the boom azimuth. So the orbit
   chased a target that its own motion pushed away: a positive-feedback
   loop that rotated the basis under a held key and turned "forward"
   into a slow right-hand arc. camera.js's latch broke the loop by
   standing the orbit down while a direction was held.

   THE CONTRACT THIS FILE NOW ASSERTS IS STRICTLY STRONGER, and it
   comes from the person playing the game, verbatim: "let's fix it to
   always be centered on him so it never sways for any reason unless
   the user is purposefully changing the camera angle." The auto-orbit
   and the 134 deg idle portrait settle are gone (camera.js, THE
   AUTO-ORBIT IS OFF). The boom azimuth is now written by exactly four
   things — a manual steer, the wedge relief, a vista, and a cut — and
   by nothing else, ever. So the assertion is no longer "the orbit does
   not own the boom while the stick is held"; it is "the boom does not
   MOVE unless the player moved it", everywhere, in every arm.

   WHAT THIS FILE MAY AND MAY NOT ASSERT ON — unchanged in spirit, and
   read it before adding anything. Two of its assertions used to read a
   leftover quantity and call it a behaviour, and both answered
   differently on the same unchanged build: B's release moved "about 0
   or about 9 deg, never in between", and C's settle scattered 46 deg
   across a 60 deg window. The residual was never a property of the
   orbit — a converged orbit moves zero, and so does a camera that is
   simply switched off. THAT AMBIGUITY IS THE WHOLE DESIGN PROBLEM OF
   THIS FILE NOW: the shipping camera is supposed to move zero degrees,
   which is also what a completely broken camera does. So every
   zero-degree assertion here is PAIRED with one that demands motion on
   the same page load, and the pairs are:

     A   boom still while W held        <- D: camSteer moves it 25 deg
     B   boom still across a release    <- D, and case B's own turn
     C   boom still standing for 12 s   <- C's own camSteer(40) control
     C   and the portrait never fires   <- E: camLegacy(true) fires it
     E   a steered boom stays steered   <- E's legacy arm drags it back

   Case E is the revert check in the form contracts.js asks for: a
   switch inside the module, both rules driven on ONE page load.
   WALLY.debug.camLegacy(true) restores the orbit, the portrait settle
   and the 3.15 m / 0.90 m boom, and case E fails if that arm does NOT
   sway — because if the old behaviour cannot be made to appear, the
   assertion that the new behaviour is absent is measuring nothing.

   Five cases:
     A  hold W for 6 s              -> path bend < 3 deg AND the boom
                                       sweeps 0 deg while it is held
     B  hold W, add A at 2.5 s      -> the path turns ~45 deg, is
                                       straight again after, the lens
                                       stays locked to his travel, and
                                       the boom does not move when the
                                       stick empties
     D  camSteer(25) with W held    -> the boom turns 25 deg (the
                                       control for A and B)
     C  stand still 12 s            -> the boom sweeps ~0, no portrait
                                       is ever solved, and a camSteer
                                       mid-case proves it still can move
     E  steer 120 deg off, on each   -> the OLD rig drags the boom back
        arm of camLegacy in turn         on its own; the new one leaves
                                         it exactly where it was put

     node tools/drifttest.mjs [--verbose]
   ============================================================ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg } from 'node:os';

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
/* 16:9 — every RIG constant is tuned there. */
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
let pageErr = null;
page.on('pageerror', (e) => { pageErr = e.message.split('\n')[0]; console.log('PAGEERROR', pageErr); });

await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 60000 });
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
      /* camInfo() is the rig's own account of itself: who wrote the boom
         azimuth this frame, what target the old orbit WOULD have been
         closing, how hard the player is pressing, and which arm of
         camLegacy() is running. Every case below asserts on these. */
      const i = window.WALLY.debug.camInfo();
      window.__drift.push({
        t: (performance.now() - t0) / 1000,
        x: w.root.position.x, z: w.root.position.z,
        cam: Math.atan2(f.x, f.z) * 180 / Math.PI,   // basis wally actually uses
        boom: (c.cam?.yaw ?? 0) * 180 / Math.PI,      // the rig's own azimuth
        face: (ct?.yaw ?? 0) * 180 / Math.PI,
        sp: ct ? Math.hypot(ct.velocity.x, ct.velocity.z) : 0,
        own: i.yawOwner, mag: i.stickMag, err: i.orbitErr, hold: i.holdYaw,
        lam: i.orbitLam, stick: i.stick, legacy: i.legacy,
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

/* ---------- letting go of two keys at once -------------------------
   `page.keyboard.up(a)` then `.up(b)` is TWO CDP messages, and under
   load a rendered frame can land between them. That frame used to be
   the whole difference between the two answers case B gave — see the
   header — so the release is done in ONE page task instead, where no
   frame can intervene. wally.js reads `keys[e.code]` off plain window
   listeners, so a dispatched KeyboardEvent is the same input to it as
   a real one; the CDP-level keys are then lifted too, so the browser's
   own idea of what is held does not drift from the page's.

   IT MATTERS LESS THAN IT DID and it is kept anyway. The old B
   measured how far a converging orbit moved, which depended on whether
   its target was frozen. B now measures whether the boom moves AT ALL,
   which is true or false however the keys come up — but a one-key
   frame is still a frame in which the player is driving on a new stick
   angle, and `bOneKey` is still printed so a future reader can tell a
   rig problem from a camera one. */
const releaseTogether = async (codes) => {
  await page.evaluate((cs) => {
    for (const code of cs) {
      window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code.slice(-1).toLowerCase(), bubbles: true }));
    }
  }, codes);
  for (const c of codes) await page.keyboard.up(c);
};

const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const at = (s, t) => s.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
/** Chord heading of the path between two times, in degrees. */
function heading(s, t0, t1) {
  const a = at(s, t0), b = at(s, t1);
  const dx = b.x - a.x, dz = b.z - a.z;
  if (Math.hypot(dx, dz) < 0.05) return null;   // did not move: no heading
  return Math.atan2(dx, dz) * 180 / Math.PI;
}
/** TOTAL degrees the boom travelled, summed frame by frame — not the
    net displacement. A camera that swings out and back is not still,
    and the net would call it still. This is the quantity every "it does
    not move" assertion in this file is written against. */
function swept(s, t0 = -Infinity, t1 = Infinity) {
  const w = s.filter((r) => r.t >= t0 && r.t <= t1);
  let tot = 0;
  for (let k = 1; k < w.length; k++) tot += Math.abs(wrap(w[k].boom - w[k - 1].boom));
  return { deg: tot, n: w.length };
}
function owners(s, t0 = -Infinity, t1 = Infinity) {
  const o = {};
  for (const r of s) if (r.t >= t0 && r.t <= t1) o[r.own] = (o[r.own] || 0) + 1;
  return o;
}
function trace(s, label) {
  if (!VERBOSE) return;
  console.log(`   ${label}: t / pathHeading / camYaw / boomYaw / facing / speed / owner`);
  for (let t = 0.5; t <= s[s.length - 1].t - 0.5; t += 1.0) {
    const h = heading(s, t - 0.25, t + 0.25);
    const p = at(s, t);
    console.log(`     ${t.toFixed(1)}s  ${h === null ? '  --  ' : h.toFixed(1).padStart(6)}  ` +
      `${p.cam.toFixed(1).padStart(7)}  ${p.boom.toFixed(1).padStart(7)}  ` +
      `${p.face.toFixed(1).padStart(7)}  ${p.sp.toFixed(2)}  ${p.own}`);
  }
}

const results = [];
/* THE SWEEP FLOOR. Not zero: boomYaw is published through
   toFixed(1) in camInfo(), so a boom that is bit-for-bit constant can
   still show +-0.05 deg of quantisation on a frame, and 350 frames of
   that is 17 deg of "sweep" if the rounding happens to alternate. In
   practice a held boom reads EXACTLY the same string every frame and
   sums to 0.0; the floor is here so that a future change which adds a
   genuine sub-pixel jitter is caught as a value, not hidden by a
   generous bound. Anything above this is a real camera move. */
const STILL = 0.5;   // degrees of total sweep that still counts as "it held"

/* ================================================================
   A — hold W for six seconds. The whole point.
   The first 0.5 s is the acceleration ramp (he is still building
   speed and the springs are still settling), so the START heading is
   measured from 0.5-1.5 s and the END heading from 5.5-6.5 s.
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
const aHeld = A.filter((s) => s.mag > 0.12);
const aSweep = swept(aHeld.length ? aHeld : A);
trace(A, 'A');
console.log(`   path heading  ${a0 === null ? 'n/a' : a0.toFixed(1)} deg -> ${a1 === null ? 'n/a' : a1.toFixed(1)} deg`);
console.log(`   TOTAL PATH BEND  ${aBend === null ? 'n/a' : aBend.toFixed(1)} deg over 6 s   (camera basis moved ${aCam.toFixed(1)} deg)`);
console.log(`   boom swept ${aSweep.deg.toFixed(2)} deg over ${aSweep.n} held frames; owners ${JSON.stringify(owners(A))}`);
console.log(`   distance travelled ${Math.hypot(at(A, 6.5).x - at(A, 0.5).x, at(A, 6.5).z - at(A, 0.5).z).toFixed(1)} m`);
results.push(['A straight-line bend < 3.0 deg', aBend !== null && Math.abs(aBend) < 3.0,
  aBend === null ? 'he never moved' : `${aBend.toFixed(1)} deg`]);
results.push([`A and the boom itself never moved while W was held (<${STILL} deg swept)`,
  aSweep.n >= 60 && aSweep.deg < STILL,
  aSweep.n < 60 ? `only ${aSweep.n} held frames` : `${aSweep.deg.toFixed(2)} deg over ${aSweep.n} frames`]);
results.push(['A control: the rig was on the shipping arm, not camLegacy(true)',
  A.every((s) => s.legacy === false), `legacy=${A[0]?.legacy}`]);
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
   long as W+A is held no matter where the boom is. What must hold is
   that the lens stays locked to his travel (it never decouples or
   spins) and that NOTHING happens to the boom when he lets go — which
   under the old rule was the moment the orbit took over, and is now
   the moment most likely to expose a leftover automatic writer.
   ================================================================ */
console.log('--- B: hold W, add A at 2.5 s ---');
await startSampling();
await page.keyboard.down('KeyW');
await page.waitForTimeout(2500);
await page.keyboard.down('KeyA');
await page.waitForTimeout(4500);
await releaseTogether(['KeyA', 'KeyW']);
await page.waitForTimeout(1600);
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

/* THE RELEASE WINDOW. It starts at the first frame the RIG ITSELF sees
   an empty stick (mag <= RIG.stickDead), not at the moment the script
   sent its first key-up. Under the old rule this was where the orbit
   took the boom back and closed whatever error was left; under the new
   one it is where the boom must do nothing whatsoever, even though his
   facing is still rotating for ~100 ms underneath it. */
const bRelIdx = B.findIndex((s, i) => i > 20 && s.mag <= 0.12);
const bRel = bRelIdx < 0 ? null : B[bRelIdx];
const bWin = bRelIdx < 0 ? [] : B.slice(bRelIdx).filter((s) => s.t <= bRel.t + 1.2);
const bSweep = bRel === null ? null : swept(bWin);
const bOwners = owners(bWin);
/* ONE-KEY FRAMES — counted from the stick ANGLE, which is the thing
   that actually changed. W+A is 45 deg of stick; W alone is 0. Counted
   contiguously back from the empty frame, so a diagonal held earlier in
   the run cannot be mistaken for the race. Printed, not asserted: it
   no longer changes the answer, only the explanation. */
let bOneKey = 0;
for (let k = bRelIdx - 1; k >= 0 && B[k].mag > 0.12; k--) {
  if (Math.abs(wrap(B[k].stick)) < 25) bOneKey++; else break;
}
console.log(`   path heading ${bPre?.toFixed(1)} -> ${bPost?.toFixed(1)} deg  (turned ${bTurn?.toFixed(1)} deg; W+A is 45 deg of stick)`);
console.log(`   late-path bend ${bLateBend === null ? 'n/a' : bLateBend.toFixed(1)} deg over the last 1.3 s`);
console.log(`   lens sits ${bLock.toFixed(1)} deg off his facing while the diagonal is held (= the stick angle)`);
if (bRel === null) {
  console.log('   the rig never saw an empty stick after release — nothing to measure');
} else {
  console.log(`   stick empty at t=${bRel.t.toFixed(2)}s; boom owners for the next 1.2 s: ${JSON.stringify(bOwners)}`);
  console.log(`   boom swept ${bSweep.deg.toFixed(2)} deg over those ${bSweep.n} frames` +
    ` while the old orbit's target sat ${bRel.err.toFixed(1)} deg away`);
  console.log(`   ${bOneKey} frame(s) of one-key drive preceded the empty stick (diagnostic only)`);
}
results.push(['B the turn is the one asked for (25-70 deg, not a spin)',
  bTurn !== null && Math.abs(bTurn) > 25 && Math.abs(bTurn) < 70,
  bTurn === null ? 'no path' : `${bTurn.toFixed(1)} deg`]);
results.push(['B path straight again after the turn (<3.0 deg)',
  bLateBend !== null && Math.abs(bLateBend) < 3.0,
  bLateBend === null ? 'no path' : `${bLateBend.toFixed(1)} deg`]);
results.push(['B lens stays locked to his travel (<60 deg off facing)', bLock < 60, `${bLock.toFixed(1)} deg`]);
results.push([`B letting go does NOT move the camera (<${STILL} deg swept in the 1.2 s after the stick empties)`,
  bRel !== null && bSweep.n >= 20 && bSweep.deg < STILL,
  bRel === null ? 'stick never emptied'
    : bSweep.n < 30 ? `only ${bSweep.n} frames in the window`
      : `${bSweep.deg.toFixed(2)} deg, owners ${JSON.stringify(bOwners)}`]);
results.push(['B and no branch claimed to be orbiting (the orbit is gone on this arm)',
  bOwners.orbit === undefined, JSON.stringify(bOwners)]);
/* THE HELD CONTROL, KEPT AND RE-POINTED. It used to prove the two
   ownership assertions discriminated by showing the same window read
   'latch' while the stick was held. The orbit is gone, so what it
   proves now is narrower and still worth a line: the rig is still
   REPORTING the difference between "the player is driving" and "the
   player let go". If this ever reads 'hold' while the stick is held,
   camera.js has stopped distinguishing the two states and case B's
   window is no longer the thing it says it is. */
const bHeld = B.filter((s) => s.t < bRel.t - 0.15 && s.mag > 0.12);
const bHeldLatch = bHeld.length ? bHeld.filter((s) => s.own === 'latch').length / bHeld.length : 0;
results.push(['B control: the rig still knows a held stick from a released one (>=90% latch while held)',
  bHeld.length >= 10 && bHeldLatch >= 0.9,
  bHeld.length < 10 ? `only ${bHeld.length} held frames — too few to control on`
    : `${(bHeldLatch * 100).toFixed(0)}% latch while held  ${JSON.stringify(owners(bHeld))}`]);

/* ================================================================
   D — the player steering the CAMERA still owns the yaw, latch or no
   latch: WALLY.debug.camSteer() is api.steer(), the same entry point
   the mouse drag and the touch fling spend themselves through.

   AND IT IS THE CONTROL FOR A AND B. Both of those assert that the
   boom swept ~0 degrees, which is also what a camera nobody is writing
   at all would report. D is the same rig, the same page load and the
   same held key, and it demands 25 degrees of movement.
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
results.push(['D manual steer still turns the boom (20-30 deg) — the control for A and B',
  Math.abs(dTurn) > 20 && Math.abs(dTurn) < 30, `${dTurn.toFixed(1)} deg`]);

/* ================================================================
   C — STAND STILL AND NOTHING HAPPENS. This case used to assert the
   opposite: that after portraitDelay the boom swung 134 deg round to a
   three-quarter front and arrived there. That behaviour was removed by
   request ("it never sways for any reason"), so the case is inverted.

   Three things are measured, and the third is what makes the first two
   mean anything:

     1. the boom sweeps ~0 deg over twelve seconds of standing still
     2. no portrait is ever solved — holdYaw stays null the whole time,
        which is the mechanism, where the sweep is only its consequence
     3. a camSteer(40) in the middle of that same stillness moves the
        boom 40 deg and it then goes still again

   (3) is the local control. Without it, "the boom swept 0 deg" is
   equally satisfied by a rig that has stopped writing the camera.
   ================================================================ */
console.log('--- C: stand still, the boom must NOT move ---');
await page.waitForTimeout(1800);
await startSampling();
await page.waitForTimeout(6000);
const cMid0 = await page.evaluate(() => window.WALLY.debug.camInfo());
await page.evaluate(() => window.WALLY.debug.camSteer(40));
await page.waitForTimeout(600);
const cMid1 = await page.evaluate(() => window.WALLY.debug.camInfo());
await page.waitForTimeout(6000);
const C = await stopSampling();
trace(C, 'C');
const cT = C[C.length - 1].t;
const cSteerT = 6.0;          // when the control steer was injected
const cBefore = swept(C, 0.4, 5.6);                 // before the steer
const cAfter = swept(C, cSteerT + 2.2, cT - 0.2);   // after it has settled
const cSteerTurn = wrap(cMid1.yaw - cMid0.yaw);
const cPortrait = C.filter((s) => s.hold !== null).length;
const cOwn = owners(C, 0.4, 5.6);
console.log(`   boom swept ${cBefore.deg.toFixed(2)} deg over ${cBefore.n} standing frames before the steer,` +
  ` ${cAfter.deg.toFixed(2)} deg over ${cAfter.n} after it`);
console.log(`   camSteer(40) moved it ${cSteerTurn.toFixed(1)} deg (${cMid0.yaw} -> ${cMid1.yaw})`);
console.log(`   owners while standing: ${JSON.stringify(cOwn)};` +
  ` a portrait azimuth was held on ${cPortrait} of ${C.length} frames`);
results.push([`C standing still for 5 s moves the boom not at all (<${STILL} deg swept)`,
  cBefore.n >= 40 && cBefore.deg < STILL,
  cBefore.n < 40 ? `only ${cBefore.n} frames` : `${cBefore.deg.toFixed(2)} deg over ${cBefore.n} frames`]);
results.push([`C and it is still not moving 8 s later (<${STILL} deg swept)`,
  cAfter.n >= 40 && cAfter.deg < STILL,
  cAfter.n < 40 ? `only ${cAfter.n} frames` : `${cAfter.deg.toFixed(2)} deg over ${cAfter.n} frames`]);
results.push(['C the portrait settle never fires (holdYaw stays null) — the MECHANISM, not the residual',
  cPortrait === 0, `${cPortrait} frame(s) held a portrait azimuth`]);
results.push(['C control: a camSteer in the middle of that stillness DOES move it (35-45 deg)',
  Math.abs(cSteerTurn) > 35 && Math.abs(cSteerTurn) < 45, `${cSteerTurn.toFixed(1)} deg`]);
results.push(['C the resting branch is `hold`, i.e. the rig is choosing not to move it',
  (cOwn.hold || 0) / Math.max(1, cBefore.n) >= 0.9, JSON.stringify(cOwn)]);

/* ================================================================
   E — THE REVERT CHECK. Contracts.js rule 1, strong form: a switch in
   the module driving the shipping rule and the prior rule on ONE page
   load. WALLY.debug.camLegacy(true) puts the auto-orbit, the portrait
   settle and the old boom back.

   THIS IS THE ONLY ASSERTION IN THE FILE THAT DEMANDS A SWAY, and it
   is what stops every other assertion here from being vacuous. If the
   legacy arm stands as still as the shipping arm, then either the
   switch is not wired to anything or standing still is not a property
   this rig can fail — and in both cases cases A, B and C prove nothing
   about the change they were written for.

   It is deliberately measured on the IDLE settle rather than the run
   orbit: the settle is the bigger and more repeatable of the two (134
   deg at lambda 0.70 against a few degrees a second at a walk), and it
   is the one the player actually complained about.

   AND IT HAS TO BE GIVEN SOMETHING TO CLOSE. The first version of this
   case just flipped the switch and watched for twelve seconds, and it
   FAILED on a correct legacy arm: 0.0 degrees swept over 410 frames
   with `yawOwner` reading 'orbit' and a portrait held on every one of
   them. camLegacy(true) snaps the boom onto the portrait as it flips,
   so the orbit was alive, owned the boom, and had nothing to do —
   which is the exact failure the header of this file describes for the
   old case B, reproduced by the person who wrote that paragraph.
   So both arms are STEERED 120 degrees off first. It is the same
   stimulus for both, and the whole difference between the two rules is
   what happens next: the legacy orbit drags the boom back to a
   portrait, and the shipping rig leaves it exactly where the player
   put it. The steer lands BEFORE sampling starts, so what is measured
   is only the rig's own response to it.
   ================================================================ */
console.log('--- E: camLegacy(true) must sway, camLegacy(false) must not ---');
const eArm = async (on, secs) => {
  await page.evaluate((L) => window.WALLY.debug.camLegacy(L), on);
  await page.waitForTimeout(1600);
  await page.evaluate(() => window.WALLY.debug.camSteer(-120));
  await page.waitForTimeout(250);
  await startSampling();
  await page.waitForTimeout(secs * 1000);
  return stopSampling();
};
const E = await eArm(true, 12);
/* from 1.6 s, i.e. after RIG.steerHold (1.35 s) has expired and the
   rig — whichever rig it is — has the boom back */
const eSweep = swept(E, 1.6, E[E.length - 1].t - 0.2);
const eOwn = owners(E, 1.6);
const ePortrait = E.filter((s) => s.hold !== null).length;
console.log(`   legacy arm, steered 120 deg off: boom swept ${eSweep.deg.toFixed(1)} deg back over ${eSweep.n} frames;` +
  ` owners ${JSON.stringify(eOwn)}; portrait held on ${ePortrait} frames`);
const E2 = await eArm(false, 9);
const e2Sweep = swept(E2, 1.6, E2[E2.length - 1].t - 0.2);
const e2Own = owners(E2, 1.6);
console.log(`   shipping arm, same 120 deg steer: boom swept ${e2Sweep.deg.toFixed(2)} deg over ${e2Sweep.n} frames;` +
  ` owners ${JSON.stringify(e2Own)}`);
results.push(['E REVERT CHECK: camLegacy(true) drags a steered boom back on its own (>20 deg swept)',
  eSweep.n >= 60 && eSweep.deg > 20,
  eSweep.n < 60 ? `only ${eSweep.n} frames` : `${eSweep.deg.toFixed(1)} deg`]);
results.push(['E and the legacy arm solves a portrait, which the shipping arm never does',
  ePortrait > 0 && (eOwn.orbit || 0) > 0,
  `portrait on ${ePortrait} frames, owners ${JSON.stringify(eOwn)}`]);
results.push([`E and the SHIPPING arm leaves the same steer exactly where the player put it (<${STILL} deg)`,
  e2Sweep.n >= 60 && e2Sweep.deg < STILL,
  e2Sweep.n < 60 ? `only ${e2Sweep.n} frames` : `${e2Sweep.deg.toFixed(2)} deg`]);
/* THE WEDGE RELIEF, WHICH THIS CASE IS THE REASON WE FOUND.
   E's 120 deg steer puts the boom into the building behind the spawn
   grass, which is the one condition that wakes camera.js's relief
   solve. On the first draft of this pass the relief was still live on
   the shipping arm, and that is exactly what this case caught: 92.44
   deg of boom rotation, in 45 frames of `relief`, with the player's
   hands off the controls — a bigger unrequested move than the orbit
   ever made at a walk. It is legacy-only now. Assert BOTH halves: the
   shipping arm must show no relief at all, and the legacy arm must
   still show some, or the first half is being satisfied by a stimulus
   that stopped reaching the wall. */
results.push(['E the wedge relief does not rotate the shipping boom (0 relief frames)',
  (e2Own.relief || 0) === 0, `${e2Own.relief || 0} relief frame(s), owners ${JSON.stringify(e2Own)}`]);
results.push(['E control: the same steer DOES wedge the legacy arm, so the line above was tested',
  (eOwn.relief || 0) > 0, `${eOwn.relief || 0} relief frame(s) on the legacy arm`]);

results.push(['no page errors', pageErr === null, pageErr || 'clean']);

console.log('');
let ok = true;
for (const [name, pass, detail] of results) {
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  [${detail}]`);
}
console.log(`\nrig: 1600x900, headless Chrome, SwiftShader; load ${loadavg()[0].toFixed(2)} (1 min)`);
console.log(ok
  ? '\nPASS — holding forward goes forward, and the camera holds still until the player moves it'
  : '\nFAIL — something is still moving the camera, or nothing is');

await browser.close();
server.close();
process.exit(ok ? 0 : 1);
