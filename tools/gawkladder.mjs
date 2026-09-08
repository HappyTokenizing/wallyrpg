#!/usr/bin/env node
/* gawkladder.mjs — WHO IS LOOKING UP, AND CAN THE PLAYER SEE THEM.

   Boards the balloon over a REAL, populated street at a REAL busy hour,
   points the flight camera over the crowd (the boom is seeded from the
   follow rig's lens, so Wally's yaw before boarding IS the flight
   camera's heading), and walks a ladder of altitudes reporting the
   whole chain that has to hold for the feature to exist:

     awake -> in the camera frustum -> h.active (ANIM_FAR + budget)
           -> eligible -> lookW -> head pitch -> readable in pixels

   contracts.js rule 5: arrive() is asserted, and where the lens
   actually ended up is printed beside every row.

   node tools/gawkladder.mjs [loc] [alt,alt,...] [--shots]
*/
import { boot } from './_perf-lib.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const SHOTS = process.argv.includes('--shots');
const LOC = args[0] || 'markethall';
const ALTS = (args[1] || '0,6,12,19,26,34,45,60,80,120').split(',').map(Number);
const OUT = 'shots/voices/gawk';
const logs = [];
const { page, close } = await boot({ w: 1600, h: 900, qs: '?skipIntro', logs });
if (SHOTS) await mkdir(OUT, { recursive: true });
await page.waitForTimeout(4000);

const ok = await page.evaluate((loc) => WALLY.debug.arrive(loc), LOC);
if (ok !== true) { console.error('arrive(' + LOC + ') !== true:', ok); await close(); process.exit(2); }

/* A BUSY HOUR, because the crowd is a function of the clock: crowd.js
   hourDensity() is 0.48 at 07:12 (where a fresh save starts) and 1.00
   at 13:00, and half a crowd is half an answer. */
const clock = await page.evaluate(() => {
  const t = WALLY.ctx.game.time;
  const want = 13 - (t.hour ?? 12);
  if (want > 0) t.advance(Math.round(want * 60), 0);
  return { hour: +(WALLY.ctx.game.time.hour).toFixed(2) };
});

/* AND POINT THE LENS AT THE PEOPLE. The fly rig seeds its boom from
   the follow rig's lens, so whichever way he is facing when he boards
   is the way the flight camera looks for the whole flight. Facing him
   at the crowd's own centroid is the difference between measuring the
   feature and photographing a field (contracts.js rule 5).

   THE CENTROID IS TAKEN OVER 400 m, NOT 80. An 80 m centroid is the
   crowd standing around the machine — and that crowd is exactly the
   one that is BELOW the bottom of the frame at every altitude, because
   the boom pitches down 16-30 degrees and never looks at its own feet.
   A ladder aimed that way photographs the outskirts: the first 90 m
   frame this rig produced after the pinning fix was a hillside of
   trees with 37 people drawn somewhere off the side of it. Aim it at
   the mass of the city instead, which is what is actually in the
   picture from 20 m up.

   WEIGHTED BY 1/d, so a far district cannot outvote a near one purely
   by being large; the centroid stays over the streets rather than
   sliding to the middle of the island. */
const aimed = await page.evaluate(() => {
  const c = WALLY.ctx, p = c.wally.position;
  let sx = 0, sz = 0, n = 0, w = 0;
  for (const h of c.npc.humans) {
    if (h.asleep) continue;
    const d = Math.hypot(h.root.position.x - p.x, h.root.position.z - p.z);
    if (d > 400 || d < 25) continue;
    const k = 1 / d;
    sx += h.root.position.x * k; sz += h.root.position.z * k; w += k; n++;
  }
  if (!n) return { n: 0 };
  const yaw = Math.atan2(sx / w - p.x, sz / w - p.z);
  c.wally.setYaw(yaw);
  /* WHERE THE LADDER IS FLOWN, kept so every rung is flown from the
     same spot over the same street facing the same way — see hold(). */
  return { n, yawDeg: +(yaw * 180 / Math.PI).toFixed(1),
    x: p.x, z: p.z, yaw };
});
const HOME = aimed.n ? aimed : { x: 0, z: 0, yaw: 0 };
await page.waitForTimeout(3000);
console.log('loc', LOC, 'clock', JSON.stringify(clock), 'aim', JSON.stringify(aimed));

/* THE CONTROL IS TAKEN BEFORE THE RIDE IS GRANTED, and that is not
   fussiness. game.js's bikeSync() reconciles the ride against ctx.game
   every half second, so grantRide('balloon') alone BOARDS him — the
   first version of this rig granted it at boot and its "altitude 0"
   row was a boarded balloon at ground level, which is not a control at
   all. Every number in this row must be the pre-change one: reach 70,
   the crowd exactly as it walks. */
const rows = [];
const measure = async (alt, tag) => {
  const r = await page.evaluate((a) => {
    const ctx = WALLY.ctx, cam = ctx.camera, npc = ctx.npc;
    cam.updateMatrixWorld();
    const camP = cam.position.clone();
    const wp = ctx.wally.position;
    const scratch = camP.clone();
    const PXH = 900;
    let awake = 0, inFrustum = 0, active = 0, gawkOn = 0, looking = 0;
    let seenLooking = 0, nearestD = 1e9, biggestSeen = 0, biggestLooking = 0;
    let craneSum = 0, craneN = 0, craneMax = 0, inRange = 0;
    const sample = [];
    for (const h of npc.humans) {
      if (h.asleep) continue;
      awake++;
      const p = h.root.position;
      const dCam = p.distanceTo(camP);
      const dBal = Math.hypot(p.x - wp.x, p.y + 1.1 - wp.y, p.z - wp.z);
      if (dCam < nearestD) nearestD = dCam;
      if (dBal < 70) inRange++;
      if (h.active) active++;
      if (h.gawkOn) gawkOn++;
      const head = scratch.set(p.x, p.y + h.height, p.z).project(cam).clone();
      const feet = scratch.set(p.x, p.y, p.z).project(cam).clone();
      const vis = head.z > -1 && head.z < 1 && Math.abs(head.x) < 1 && Math.abs(head.y) < 1;
      const bodyPx = Math.abs(head.y - feet.y) * PXH * 0.5;
      if (vis) { inFrustum++; if (bodyPx > biggestSeen) biggestSeen = bodyPx; }
      const crane = h.anim ? -h.anim.headPitch * 180 / Math.PI : 0;
      if (h.gawkOn && h.anim && h.anim.lookW > 0.3) {
        looking++;
        /* CRANE IS A SKELETON NUMBER AND ONLY A SKELETON NUMBER.
           headPitch is written by anim.update(), which runs only for
           h.active — so averaging it over the instanced band would
           divide a real crane angle by a hundred people who have no
           head to pitch and report "the city stopped craning" about a
           city that is craning fine. It is the close-up's number; the
           far band's is `sky` and `seen`. */
        if (h.active) { craneSum += crane; craneN++; if (crane > craneMax) craneMax = crane; }
        if (vis) { seenLooking++; if (bodyPx > biggestLooking) biggestLooking = bodyPx; }
        /* WHERE IN THE FRAME, in pixels, because "39 people are
           looking up" and "you can find one in the picture" are two
           different claims and only the second one is the feature.
           This is the column that turns a crop into an aimed crop. */
        if (sample.length < 5) sample.push({ dCam: +dCam.toFixed(1), dBal: +dBal.toFixed(1),
          crane: +crane.toFixed(1), vis, px: +bodyPx.toFixed(1),
          sx: ((head.x * 0.5 + 0.5) * 1600) | 0, sy: ((-head.y * 0.5 + 0.5) * PXH) | 0 });
      }
    }
    const dir = camP.clone(); cam.getWorldDirection(dir);
    const sc = WALLY.debug.bubbleScene().gawk;
    /* THE ALTITUDE ACTUALLY FLOWN, not the one asked for. balloon({alt})
       teleports and then the flight model runs, so nine seconds later
       the machine is somewhere else; a ladder labelled by its request
       is a ladder of requests. */
    const gy = ctx.world.heightAt(wp.x, wp.z);
    /* WHAT THE PICTURE COSTS, beside what is in it. The claim of the
       instanced band is that a city noticing you costs LESS than a city
       you cannot see, so the draw-call and triangle counts belong on
       the same row as the head count and not in a separate run. */
    const P = window.__WALLY_PERF__ || {};
    /* DRAWN NOW HAS TWO HALVES and the old column only counted one.
       `skin` is h.root.visible — a solved skeleton; `sky` is one
       instance in the billboard call. Both are a person on the screen;
       only one costs bones. A row that prints skin and hides sky is
       the row that shipped this bug twice. */
    const sky = WALLY.debug.skyCrowd();
    const skin = npc.humans.filter((h) => h.root.visible).length;
    return { alt: a, agl: +(wp.y - gy).toFixed(1), camY: +camP.y.toFixed(1),
      back: +Math.hypot(camP.x - wp.x, camP.z - wp.z).toFixed(1),
      pitch: +(Math.asin(-dir.y) * 180 / Math.PI).toFixed(1), fov: +cam.fov.toFixed(1),
      awake, inRange, inFrustum, skin, sky: sky.drawn, skyMode: sky.mode,
      drawn: skin + sky.drawn,
      calls: P.calls ?? 0, tris: P.tris ?? 0, fps: P.fps ?? 0, settled: !!P.settled,
      active, gawkOn, looking, seenLooking,
      nearestD: +nearestD.toFixed(1), pxSeen: +biggestSeen.toFixed(1),
      pxLooking: +biggestLooking.toFixed(1),
      crane: craneN ? +(craneSum / craneN).toFixed(1) : 0, craneMax: +craneMax.toFixed(1),
      pointing: sc.pointing, stopped: sc.stopped, reach: sc.reach,
      sample };
  }, alt);
  r.tag = tag;
  rows.push(r);
  return r;
};

await measure(-1, 'foot');                 // the control, on his own legs
await page.evaluate(() => { try { WALLY.ctx.game.actions.grantRide('balloon'); } catch (e) {} });
await page.waitForTimeout(2500);
/* RE-PIN THE ALTITUDE BEFORE EVERY SAMPLE, and pin it twice.

   TWICE, because the FIRST balloon({alt}) after grantRide does not
   take: measured, a run whose first rung asked for 90 m was at 4.1 m
   agl 2.8 s later and climbing, while the same rung in a run that had
   already flown 20 m was at 95.4. Something in the boarding transition
   is still writing the height on the frame the hook sets it.

   BEFORE EVERY SAMPLE, because the machine is a flight model and it
   drifts: over the ten seconds between 'peak' and 'settled' it moved
   9 m of altitude and 3 m of standoff, which is fine for a ladder of
   rungs and fatal for an A/B, where the whole claim is that ONE
   number changed. `agl` is still printed per row and is still the
   altitude actually flown — this narrows the spread, it does not
   pretend it away.

   IT PINS THE GROUND POSITION AND THE HEADING TOO, and that is not
   tidiness. The flight model is a flight model: over the twenty-five
   seconds one rung of this ladder takes, the machine drifted off
   Market Hall and out over the north shore, and the 90 m frame that
   came back was a photograph of empty grass and the sea with 45
   people drawn somewhere off the side of it. Every altitude has to be
   flown over the SAME populated street or the ladder is measuring
   where the wind went. */
/* THE AIM IS SOLVED ONCE PER RUNG AND THEN REUSED, because hold() runs
   four times per altitude and a fresh search each time picked a fresh
   heading — the crowd walks, so the best cone moves, and the 'on' and
   'off' exposures came back as photographs of two different streets.
   A cached yaw makes the pair the same view twice, which is the only
   thing that makes it a pair. */
const AIM = new Map();
const hold = async (alt) => {
  if (alt <= 0) return;
  const cached = AIM.get(alt);
  const found = await page.evaluate(([a, hx, hz, pre]) => {
    const c = WALLY.ctx;
    /* put it back over the street, well clear of the ground, then let
       the alt hook re-derive the surface under THAT x/z */
    WALLY.debug.balloon({ at: [hx, c.world.heightAt(hx, hz) + a + 6, hz] });
    /* ---- AND AIM AT WHERE THE PEOPLE ACTUALLY ARE, PER RUNG ----

       A CENTROID IS THE WRONG TOOL AND IT COST THREE ROUNDS OF SHOTS.
       Averaging the crowd's positions gives the middle of the crowd,
       which over a coastal district is the middle of the WATER — the
       90 m frames this rig produced with a centroid aim were fields
       and sea with 42 people drawn off the edge of them. What the
       shot needs is the heading whose FRAME contains the most people,
       and those are different questions whenever the crowd is not a
       disc.

       So: sweep the compass in 5-degree steps and count who falls in
       a 44-degree cone at the range the flight camera actually looks
       at from this altitude. The band is 2.2x to 5x the altitude
       because the boom sits 20-31 m back and pitches down only 16-30
       degrees at every rung measured, so the ground under the basket
       is below the bottom edge and the picture starts well out.
       Nothing here changes the game; it changes where the tool
       points. */
    let best = 0, bestN = -1;
    const near = Math.max(60, a * 2.2), far = Math.max(240, a * 5);
    const gy = c.world.heightAt(hx, hz);
    if (pre !== null) { c.wally.setYaw(pre); WALLY.debug.balloon({ alt: a }); return pre; }
    for (let d = 0; d < 72; d++) {
      const yaw = (d * 5) * Math.PI / 180;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      /* AND NOT INTO A HILL. The boom sits 16-31 m BEHIND the basket,
         and cam.js pulls the lens in and down when that volume is
         inside geometry — so a heading whose backstop is rising ground
         does not produce a high shot, it produces a ground-level one.
         Measured: the first cone-search rung put the boom against a
         slope and came back with the balloon at 90 m agl and the lens
         at 22.7 m, pitched 7.5 degrees UP at its own envelope. Test
         the backstop out to 40 m and drop the candidate if the terrain
         there is anywhere near the lens. */
      let blocked = false;
      for (let s = 12; s <= 40; s += 14) {
        if (c.world.heightAt(hx - fx * s, hz - fz * s) > gy + a * 0.55) { blocked = true; break; }
      }
      if (blocked) continue;
      let n = 0;
      for (const h of c.npc.humans) {
        if (h.asleep) continue;
        const dx = h.root.position.x - hx, dz = h.root.position.z - hz;
        const r = Math.hypot(dx, dz);
        if (r < near || r > far) continue;
        if ((dx * fx + dz * fz) / r < 0.927) continue;   // cos(22 deg)
        n++;
      }
      if (n > bestN) { bestN = n; best = yaw; }
    }
    /* balloon({alt}) clears flyCam.seeded, so the boom re-seeds off the
       follow rig's yaw — the hook the aim block above uses, applied at
       every rung instead of only at boarding */
    c.wally.setYaw(best);
    WALLY.debug.balloon({ alt: a });
    return best;
  }, [alt, HOME.x, HOME.z, cached ?? null]);
  if (cached === undefined) AIM.set(alt, found);
  await page.waitForTimeout(500);
  await page.evaluate((a) => { WALLY.debug.balloon({ alt: a }); }, alt);
  /* AND LET THE BOOM CATCH UP. The flight camera damps toward the
     basket, so measuring on the frame after a teleport catches the
     lens 35 m low and pitched 10 degrees UP at the machine — a row
     that says the crowd is behind you when it is under you. */
  await page.waitForTimeout(1100);
};

for (const alt of ALTS) {
  await hold(alt);
  /* TWO SAMPLES, because the gesture has two halves and one time
     cannot see both. At 2.8 s everyone who is going to notice has
     noticed (the stagger tops out at 1.86 s) and every stop is still
     live; by 9 s the stops have expired and only the craning is left,
     which is what the flight looks like for the other several
     minutes of it. */
  await page.waitForTimeout(2800);
  await hold(alt);
  await measure(alt, 'peak');
  /* THE REVERT, AT THIS ALTITUDE, ON THIS PAGE LOAD. skyCrowd('off')
     is the pre-round rule to the digit — FAR = 200, thinning from 110,
     no instanced band — so the 'off' row beside every 'on' row is a
     measurement of the change and not a quotation of an older run on
     an older build. It is worth the five seconds: every previous
     round's before-number was a citation. */
  await page.evaluate(() => WALLY.debug.skyCrowd('off'));
  await page.waitForTimeout(2600);
  await hold(alt);
  await measure(alt, 'revert');
  await page.evaluate(() => WALLY.debug.skyCrowd('on'));
  await page.waitForTimeout(3600);
  await hold(alt);
  await measure(alt, 'settled');
  /* THE PAIR OF SHOTS IS TAKEN HERE, not at 'peak'.

     'peak' is 2.8 s after a teleport and the boom is still damping
     toward the basket: measured, a 90 m peak frame had the lens at
     camY 81 with a pitch of MINUS 10.7 degrees — a photograph of the
     horizon, taken from below the machine, with the whole city behind
     the camera. Two rounds of this feature were judged on frames like
     that. The settled pair is 8 s later, at the same pinned altitude,
     with the lens where the flight actually holds it. */
  if (SHOTS) {
    await page.screenshot({ path: join(OUT, `alt-${alt}.png`), timeout: 30000 });
    /* AND RE-PIN BETWEEN THE TWO EXPOSURES. The pair is only an A/B if
       it is the same view twice: taken 900 ms apart with no pin, the
       machine and the damping boom had moved the frame far enough that
       the two crops were of different houses, which is a comparison of
       nothing. */
    await page.evaluate(() => WALLY.debug.skyCrowd('off'));
    await hold(alt);
    await page.screenshot({ path: join(OUT, `alt-${alt}-off.png`), timeout: 30000 });
    await page.evaluate(() => WALLY.debug.skyCrowd('on'));
  }
}

console.log('\nask  when     mode  agl  camY back pitch reach frust drawn skin  sky act gawk look seen stop pnt nearD pxLook craneAvg craneMax calls   tris  fps');
for (const r of rows) {
  console.log(
    String(r.alt < 0 ? '-' : r.alt).padStart(3), (r.tag || '').padEnd(8),
    String(r.skyMode).padEnd(4),
    String(r.agl).padStart(5), String(r.camY).padStart(5), String(r.back).padStart(4),
    String(r.pitch).padStart(5), String(r.reach).padStart(5),
    String(r.inFrustum).padStart(5), String(r.drawn).padStart(5),
    String(r.skin).padStart(4), String(r.sky).padStart(4), String(r.active).padStart(3),
    String(r.gawkOn).padStart(4), String(r.looking).padStart(4), String(r.seenLooking).padStart(4),
    String(r.stopped).padStart(4), String(r.pointing).padStart(3),
    String(r.nearestD).padStart(5), String(r.pxLooking).padStart(6),
    String(r.crane).padStart(8), String(r.craneMax).padStart(8),
    String(r.calls).padStart(5), String((r.tris / 1000) | 0).padStart(6) + 'k',
    String(r.fps).padStart(5) + (r.settled ? '' : '*'));
}
for (const r of rows) if (r.sample.length) console.log(r.alt + 'm', JSON.stringify(r.sample));
const errs = logs.filter((l) => l.startsWith('[PAGEERROR]'));
if (errs.length) console.log('\nERRORS:\n' + errs.slice(0, 8).join('\n'));
await close();
