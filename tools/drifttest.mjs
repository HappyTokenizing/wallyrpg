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
                                              turn, the path must be
                                              straight again after it, and
                                              the LATCH must let go when
                                              the stick empties
     C  stand still                        -> the idle settle must still
                                              swing the boom to a portrait
                                              and ARRIVE on it

   WHAT THIS FILE MAY AND MAY NOT ASSERT ON. Two of its assertions used
   to read a leftover quantity and call it a behaviour, and both of them
   answered differently on the same unchanged build — B's release moved
   "about 0 or about 9 deg, never in between", and C's settle scattered
   46 deg across a 60 deg window. Neither was the game. B was two CDP
   key-up messages racing a frame boundary; C was one fixed six-second
   read taken while the boom was still moving, over a target the solver
   is entitled to choose. Both now assert the rig's OWN account of
   itself — WALLY.debug.camInfo().yawOwner / .orbitErr / .holdYaw, which
   name the branch that wrote the boom azimuth and the target it was
   closing on — and print the leftover degrees as a diagnostic. If you
   add an assertion here, assert on a mechanism the rig reports, not on
   a distance something happened to travel. See each case's note.

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
         azimuth this frame, what target they were closing on, and how
         hard the player is actually pressing. Case B asserts on these
         rather than on how far the boom happened to move — see its note. */
      const i = window.WALLY.debug.camInfo();
      window.__drift.push({
        t: (performance.now() - t0) / 1000,
        x: w.root.position.x, z: w.root.position.z,
        cam: Math.atan2(f.x, f.z) * 180 / Math.PI,   // basis wally actually uses
        boom: (c.cam?.yaw ?? 0) * 180 / Math.PI,      // the rig's own azimuth
        face: (ct?.yaw ?? 0) * 180 / Math.PI,
        sp: ct ? Math.hypot(ct.velocity.x, ct.velocity.z) : 0,
        own: i.yawOwner, mag: i.stickMag, err: i.orbitErr, hold: i.holdYaw,
        /* `lam` is the damping rate the orbit says it is using and
           `stick` the angle the player is actually pressing, in camera
           space. Case B needs both: the first to PREDICT how far a
           converging orbit should move the boom, the second to see the
           one-key frames that decide how much error is left for it. */
        lam: i.orbitLam, stick: i.stick,
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
   load a rendered frame can land between them. That frame is the whole
   difference between the two answers case B used to give — see its
   note — so the release is done in ONE page task instead, where no
   frame can intervene. wally.js reads `keys[e.code]` off plain window
   listeners, so a dispatched KeyboardEvent is the same input to it as
   a real one; the CDP-level keys are then lifted too, so the browser's
   own idea of what is held does not drift from the page's.

   THIS IS NOT THE MORE REALISTIC RELEASE — a human lifts two keys tens
   of milliseconds apart, which is one or more frames, and that case is
   measured in the note. It is the CONTROLLED one: it is the only way to
   hold the orbit's target still while the orbit is measured against
   it, and a moving target is why the old assertion was a coin flip. */
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

/* ----------------------------------------------------------------
   DOES THE ORBIT RESUME WHEN THE PLAYER LETS GO?  It is a yes/no
   question about who owns the boom, and it must be asked that way.

   The old form asked "did the boom move more than 2 deg in the 1.3 s
   after release", and that answered BOTH WAYS on one unchanged build:
   about 0 or about 9, never in between. The residual is not a property
   of the orbit. It is the error that happened to be left over when the
   stick came up, and a healthy orbit that has already arrived moves
   zero degrees and failed the assertion.

   THE RACE THAT SET IT, AND EXACTLY HOW ONE FRAME DECIDES IT.
   `page.keyboard.up('KeyA')` and `.up('KeyW')` are two CDP messages,
   and under load a rendered frame can land between them. In such a
   frame he is STILL DRIVING on a new stick angle — W alone is 0 deg,
   not 45 — so wally.js hands his controller a new wish direction and
   his facing STARTS TO TURN toward camera-forward. The turn does not
   stop when the second key-up arrives: his facing keeps rotating for
   ~100 ms after the stick is empty, and the orbit's target rides down
   onto the boom. The error is closed by the target coming to the boom
   rather than by the boom going to the target, and a healthy,
   converging orbit therefore moves almost nothing.

   Frame-by-frame across the release window, one page load, arms
   alternated, `orbitErr` read from the rig itself:

     0 frames between the key-ups   err0 42.3, and it STAYS 42 (the
                                    target is frozen); boom moves 9.0
     1 frame                        err0 30.7, target keeps falling;
                                    boom moves 0.1
     2 frames                       err0 21.9 -> -3.4 in 240 ms;
                                    boom moves 0.2
    15 frames (250 ms stagger)      err0 -4.0; boom moves 1.0

   That is the whole bimodality: a single intervening frame is enough
   to commit his facing to a turn that then completes on its own, so
   the residual is ~9 deg with no frame between and ~0 with any. It was
   never "about 0 or about 9" because the camera had two behaviours —
   it is one behaviour sampled against a target that is either moving
   or frozen. In 24 release trials across three release idioms, the
   number of frames in that window NOT owned by the orbit was ZERO.

   The 9 deg is itself just arithmetic, not a threshold anyone chose:
   RIG.orbitIdle is 0.18, so an exponential damp closes 1-e^-(0.18*1.3)
   = 21% of the error in the 1.3 s window, and 21% of 42 deg is 8.9.

   So: the window starts at the first frame the RIG ITSELF sees an
   empty stick (mag <= RIG.stickDead), not at the moment the script
   sent its first key-up, and what is asserted is ownership. The number
   of degrees left over is printed, never asserted on. */
const REL_GRACE = 0.35;   // seconds the latch may take to let go
const bRelIdx = B.findIndex((s, i) => i > 20 && s.mag <= 0.12);
const bRel = bRelIdx < 0 ? null : B[bRelIdx];
const bWin = bRelIdx < 0 ? [] : B.slice(bRelIdx).filter((s) => s.t <= bRel.t + 1.2);
const bOwnFirst = bWin.find((s) => s.own === 'orbit');
const bHandover = bOwnFirst ? bOwnFirst.t - bRel.t : null;
const bSettled = bWin.filter((s) => s.t >= bRel.t + REL_GRACE);
const bOrbitShare = bSettled.length ? bSettled.filter((s) => s.own === 'orbit').length / bSettled.length : 0;
const bOwners = {};
for (const s of bWin) bOwners[s.own] = (bOwners[s.own] || 0) + 1;
/* ONE-KEY FRAMES — counted from the stick ANGLE, which is the thing
   that actually changed, and not from the error, which is the effect
   this number exists to explain. W+A is 45 deg of stick; W alone is 0.
   Counted contiguously back from the empty frame, so a diagonal held
   earlier in the run cannot be mistaken for the race. */
let bOneKey = 0;
for (let k = bRelIdx - 1; k >= 0 && B[k].mag > 0.12; k--) {
  if (Math.abs(wrap(B[k].stick)) < 25) bOneKey++; else break;
}
/* IS THE ORBIT ACTUALLY CLOSING THE ERROR, or is `yawOwner` a label on
   a branch that does nothing? The orbit reports the lambda it damps at,
   so the degrees it OUGHT to move are predictable in advance:
   err0 * (1 - e^-(integral of lambda dt)) over the frames that really
   ran. That turns the residual — the very number that used to be a coin
   flip — into an OUTPUT of the stated mechanism, checked against a
   prediction made from the rig's own lambda rather than against a
   constant someone picked.

   THE PREDICTION HOLDS ONLY WHILE THE TARGET IS STILL, and that is not
   a caveat, it is the same fact case B is about. A first draft of this
   assertion was written without it and FAILED on a run with three
   one-key frames — moved 0.3 deg where the closed form said 3.0 —
   because the target was walking down onto the boom the whole time and
   an expression in err0 alone cannot know that. Hence releaseTogether()
   above: with the release atomic the target is frozen at the moment of
   release, err0 is the standing 42 deg of the held diagonal, and the
   closed form applies. Measured that way it predicted the residual to
   within 0.8 deg over 12 releases in one page load. `bOneKey` is
   asserted to be 0 alongside it, so if the atomic release ever stops
   being atomic this file says so instead of quietly failing the
   convergence check for a reason that is not the camera's fault. */
let bLamInt = 0;
for (let k = 1; k < bWin.length; k++) bLamInt += bWin[k].lam * (bWin[k].t - bWin[k - 1].t);
const bMoved = bRel === null ? null : Math.abs(wrap(bWin[bWin.length - 1].boom - bRel.boom));
const bPred = bRel === null ? null : Math.abs(bRel.err) * (1 - Math.exp(-bLamInt));
console.log(`   path heading ${bPre?.toFixed(1)} -> ${bPost?.toFixed(1)} deg  (turned ${bTurn?.toFixed(1)} deg; W+A is 45 deg of stick)`);
console.log(`   late-path bend ${bLateBend === null ? 'n/a' : bLateBend.toFixed(1)} deg over the last 1.3 s`);
console.log(`   lens sits ${bLock.toFixed(1)} deg off his facing while the diagonal is held (= the stick angle)`);
if (bRel === null) {
  console.log('   the rig never saw an empty stick after release — nothing to measure');
} else {
  console.log(`   stick empty at t=${bRel.t.toFixed(2)}s; boom owners for the next 1.2 s: ${JSON.stringify(bOwners)}`);
  console.log(`   orbit took the boom ${bHandover === null ? 'NEVER' : `${(bHandover * 1000).toFixed(0)} ms`} after the stick emptied,` +
    ` and held it for ${(bOrbitShare * 100).toFixed(0)}% of the rest`);
  console.log(`   error left for it to close: ${bRel.err.toFixed(1)} deg  ->  ${bWin[bWin.length - 1].err.toFixed(1)} deg`);
  console.log(`   boom moved ${bMoved.toFixed(1)} deg; a damp at the rig's own lambda` +
    ` (integral ${bLamInt.toFixed(2)}) predicts ${bPred.toFixed(1)} deg`);
  console.log(`   ${bOneKey} frame(s) of one-key drive preceded the empty stick` +
    ` — 0 means the target was frozen at release, >=1 means it was still coming to meet the boom`);
}
results.push(['B the turn is the one asked for (25-70 deg, not a spin)',
  bTurn !== null && Math.abs(bTurn) > 25 && Math.abs(bTurn) < 70,
  bTurn === null ? 'no path' : `${bTurn.toFixed(1)} deg`]);
results.push(['B path straight again after the turn (<3.0 deg)',
  bLateBend !== null && Math.abs(bLateBend) < 3.0,
  bLateBend === null ? 'no path' : `${bLateBend.toFixed(1)} deg`]);
results.push(['B lens stays locked to his travel (<60 deg off facing)', bLock < 60, `${bLock.toFixed(1)} deg`]);
results.push(['B the latch lets go on release (orbit owns the boom within 350 ms)',
  bHandover !== null && bHandover <= REL_GRACE,
  bRel === null ? 'stick never emptied' : bHandover === null ? 'orbit NEVER took it' : `${(bHandover * 1000).toFixed(0)} ms`]);
results.push(['B and it keeps it (>=90% of the following second)',
  bOrbitShare >= 0.9, `${(bOrbitShare * 100).toFixed(0)}%  ${JSON.stringify(bOwners)}`]);
results.push(['B instrument check: the release was atomic, so the orbit target was frozen (0 one-key frames)',
  bRel !== null && bOneKey === 0,
  bRel === null ? 'stick never emptied' : `${bOneKey} one-key frame(s)`]);
results.push(['B and the orbit CONVERGES, not just owns: the boom moves what a damp at its own lambda predicts (<2 deg out)',
  bMoved !== null && bOneKey === 0 && Math.abs(bMoved - bPred) < 2.0,
  bRel === null ? 'stick never emptied'
    : bOneKey !== 0 ? `not measurable: ${bOneKey} one-key frame(s) left the target moving`
      : `moved ${bMoved.toFixed(1)}, predicted ${bPred.toFixed(1)}`]);

/* THE PAIRED CONTROL, AND THE REASON THIS BLOCK EXISTS AT ALL.
   The two assertions above replaced one that read "the boom moved
   more than 2 deg in 1.3 s", which was a coin flip on every build
   including HEAD: measured 0.1 / 0.1 / 0.3 / 0.5 / 8.7 / 9.1 / 9.2
   on unmodified source. It was bimodal because the residual is not
   a property of the orbit — a healthy orbit that has already
   arrived moves ZERO — so the old test was sampling how much error
   happened to be left when the stick came up.
   Ownership is the right quantity. But an ownership test that only
   ever runs on a released stick could pass by answering 'orbit' to
   everything, so it is worth one line to show it discriminates:
   the SAME window, sampled while the stick is still HELD, must read
   'latch' and must NOT read orbit. If this control ever goes green
   the two assertions above have stopped measuring anything. */
const bHeld = B.filter((s) => s.t < bRel.t - 0.15 && s.mag > 0.12);
const bHeldOwners = {};
for (const s of bHeld) bHeldOwners[s.own] = (bHeldOwners[s.own] || 0) + 1;
const bHeldOrbit = bHeld.length ? bHeld.filter((s) => s.own === 'orbit').length / bHeld.length : 1;
results.push(['B control: while the stick is HELD the orbit does NOT own the boom (else the two above prove nothing)',
  bHeld.length >= 10 && bHeldOrbit <= 0.1,
  bHeld.length < 10 ? `only ${bHeld.length} held frames — too few to control on`
    : `${(bHeldOrbit * 100).toFixed(0)}% orbit while held  ${JSON.stringify(bHeldOwners)}`]);

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
/* ================================================================
   C — the idle settle must survive. Stand still: after portraitDelay
   the boom swings to the three-quarter portrait (RIG.portraitBias,
   134 deg off his facing, either hand).

   THIS ONE WAS NOT MEASURING ITS SENTENCE EITHER. It read the boom at
   a fixed six seconds and asserted the number landed in 104-164, and
   on HEAD alone it produced 105.8, 129.2, 140.1 and 152.2 — a 46 deg
   spread inside a 60 deg window. Two separate things were being mixed:

     1. THE SOLVER LEGITIMATELY CHOOSES. pickPortraitYaw sweeps
        +-portraitWin (30 deg) around +-portraitBias and takes the
        clearest, so where he is standing decides the target. Measured
        at five known spots in one page load, the targets it picked
        were 104.0, 122.0, 134.0, 134.0 and 134.0 deg off his facing.
        That spread is the rig working, not failing.
     2. SIX SECONDS IS MID-SETTLE. At the same five spots the boom was
        still 1.0, 4.1, 4.9, 3.6 and 5.5 deg short of that target at
        t=6 s, and 0.1-0.5 deg short at t=9 s. So the old reading was
        biased LOW by about 5 deg every time — and at the 104.0 spot
        that pushed it to 103.0, which the old `cEnd > 104` bound would
        have failed on a rig that was behaving perfectly.

   So the two facts are asserted separately, on the settled boom:
   the solver picked an azimuth inside the window, and the boom
   actually ARRIVED there. Arrival is also the only place this file
   proves the orbit closes error at all, now that case B asserts
   ownership rather than degrees travelled.
   ================================================================ */
console.log('--- C: stand still, the boom must settle to a portrait ---');
const cInfo = async () => page.evaluate(() => {
  const c = window.WALLY.ctx, i = window.WALLY.debug.camInfo();
  const face = (c.wally.controller?.yaw ?? 0) * 180 / Math.PI;
  const w = (d) => ((((d) + 180) % 360 + 360) % 360) - 180;
  return {
    off: Math.abs(w(i.yaw - face)),                       // boom, off his facing
    target: i.holdYaw === null ? null : Math.abs(w(i.holdYaw - face)),
    err: Math.abs(i.orbitErr), own: i.yawOwner, yaw: i.yaw,
  };
});
const cStart = (await cInfo()).off;
/* Poll until the boom has stopped, instead of reading it at a fixed
   time: the settle is a damp, so when it finishes depends on how far
   it had to come. Give up at 12 s and report that it never settled. */
const cTrack = [];
let cPrev = null, cSettleT = null, cLast = null;
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(500);
  cLast = await cInfo();
  if (i % 2 === 1) cTrack.push(cLast.off);
  const t = (i + 1) * 0.5;
  if (cPrev !== null && Math.abs(cLast.off - cPrev) < 0.15 && t > 3 && cSettleT === null) cSettleT = t;
  cPrev = cLast.off;
  if (cSettleT !== null && t >= cSettleT + 1.0) break;
}
const cEnd = cLast.off;
console.log(`   boom off his facing: ${cStart.toFixed(0)} -> ${cTrack.map((v) => v.toFixed(0)).join(' -> ')} deg`);
console.log(`   (0 = on his tail, RIG.portraitBias = 134 = the three-quarter front)`);
console.log(`   settled after ${cSettleT === null ? 'NEVER (12 s)' : `${cSettleT.toFixed(1)} s`};` +
  ` solver asked for ${cLast.target === null ? 'no portrait at all' : `${cLast.target.toFixed(1)} deg`},` +
  ` boom reached ${cEnd.toFixed(1)} deg (${cLast.err.toFixed(2)} deg short, owner ${cLast.own})`);
results.push(['C idle settle swings the boom round to his face (>100 deg off)',
  cEnd > 100, `${cEnd.toFixed(1)} deg`]);
results.push(['C the portrait solver picked an azimuth inside its own window (104-164 deg)',
  cLast.target !== null && cLast.target >= 103.5 && cLast.target <= 164.5,
  cLast.target === null ? 'no portrait was ever solved' : `${cLast.target.toFixed(1)} deg`]);
results.push(['C and the boom actually arrived there (<2 deg short, and it stopped)',
  cSettleT !== null && cLast.target !== null && Math.abs(cEnd - cLast.target) < 2.0,
  cSettleT === null ? 'never settled inside 12 s'
    : cLast.target === null ? 'no target' : `${Math.abs(cEnd - cLast.target).toFixed(2)} deg short`]);

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
