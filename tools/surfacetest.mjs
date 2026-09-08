#!/usr/bin/env node
/* ============================================================
   surfacetest.mjs — "does he stand ON the ground you can see?"

   The collision world is not the world. Terrain is streamed to phys as
   a 2 m heightfield sampled from the raster; the ground you LOOK at is
   a four-LOD mesh, plus road ribbons, plus building foundations, berms,
   plaza pads, pier decking and steps, each drawn by a different module.
   Every one of those is a chance for the surface under his feet and the
   surface under your eye to disagree — and when they do he sinks to the
   ankles, or hovers, or catches on a lip he should have stepped over.

   THE MEASUREMENT is deliberately not heightAt() vs groundAt(): both of
   those are the collision world's opinion of itself. This raycasts the
   DRAWN meshes — the actual triangles the renderer submits, at whatever
   LOD they are currently at, outline hulls and foliage excluded — and
   compares that to where the controller has actually put his feet.

     err = feetY - drawnY      > 0 floats,  < 0 sinks

   He is WALKED, not teleported around, because the LOD he is standing
   on is a function of where the camera is, and because a walk is the
   only thing that finds a catch: a lip he stops dead against, a step he
   cannot mount, a threshold that eats his speed.

   Route: a leg through each of the ten districts, plus the four
   surfaces that are their own kind of problem — the beach and the
   waterline, the plaza and its pavements, the pier decking, and a
   building threshold.

     node tools/surfacetest.mjs [--verbose] [--step 0.5]
   ============================================================ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

/* Tolerances. A clay character's foot is not a laser: a couple of
   centimetres of disagreement is invisible. A tenth of a metre is a
   visible sink, and a quarter is the bug the props agent hit when its
   contact decals disappeared under the terrain. */
const SINK_TOL = 0.12;
const FLOAT_TOL = 0.14;

/* ------------------------------------------------------------------
   A KNOWN DEFECT THIS TEST FINDS OR MISSES DEPENDING ON THE WALK.

   At (-24.0, -200.2), where the Green Edge and Iron Hills lanes
   converge on the Iron Hills anchor, EIGHT drawn road surfaces stack
   over one another and the highest of them stands 0.154 m over the
   terrain the controller is on. world/paths.js documents this at the
   same coordinate, names the cause (two district ribbon buckets
   overlapping across the boundary, 0.132 m and 0.041 m at the same
   point) and says the fix — cutting the ribbon at the boundary, or
   letting one lane win a junction — is not that file's change.

   IT IS NOT ROUTE-DEPENDENT; FINDING IT IS, AND IT IS NOT ONE METRE.
   Rastered statically at 0.5 m over the 16 x 16 m square centred on
   (-24, -200) — no capsule, no walk, so the same measurement in any
   build — the defect is a patch roughly 16 m by 12 m:

                          points past SINK_TOL     worst
     clean HEAD archive      226 of 1089         -0.4205
     with the ground pass    241 of 1089         -0.4205

   Same worst value, same coordinate, same mesh (road.zone:greenedge),
   both builds. The fifteen extra points are the new footway reaching a
   little further into the junction at its edges; the 226 were there
   before anything on the ground was drawn.

   And yet HEAD's ironhills LEG reports 0 samples past tolerance and a
   worst sink of -0.031, because it is walked and its route misses the
   patch. Add a kerb anywhere on the island, the controller ends up a
   metre to one side eighty metres earlier, the leg crosses the patch
   and the row goes red on geometry nobody touched.

   So a green ironhills row is not evidence that this is fixed and a
   red one is not evidence that anything regressed. Read the row, then
   raster the patch — the per-leg "N of M past sink" count printed
   below is there to tell one bad metre from a bad district.

   ------------------------------------------------------------------
   AND THE DIAGNOSIS ABOVE, WHICH BOTH FILES CARRIED, WAS WRONG.
   [placement round] Everything above about ROUTE-DEPENDENCE stands and
   is the reason this section is here. The CAUSE was not the two
   ribbons overlapping. Measured: every road vertex within 3 m of
   (-24, -200) sits at exactly heightAt + 0.030 — 27 on the Green Edge
   mesh, 64 on the Iron Hills one, mean 0.0300, worst 0.0300 — so
   neither ribbon was drawn wrong and stacking them changed nothing.
   Two separate faults were sitting on the same coordinate:

     · a flat QUAD spanning the corner where the cut bank meets the
       road, which no chord length fixes because the sag falls only as
       the square of the chord. paths.js now measures each route and
       shortens its chord until the lattice stops bridging, and fans
       the few quads that still do.
     · the CARVE, which pulled each grid node onto the last edge that
       reached it. At a junction that put two profiles 0.8 m apart on
       adjacent nodes of a 2 m heightfield and left a 48-degree face
       with a road drawn down it — n.y 0.671, and a capsule-lift term
       of 0.152 m that this file correctly reports as a sink because
       the ground really is too steep to be a road. The carve now
       accumulates every profile and writes the grid once.

   After both: n.y at (-24, -200) is 0.783, the two ribbons agree to
   0.006 m, and the ironhills leg goes from 36 of 385 samples past
   SINK_TOL to none. The console recipe below still reproduces the
   patch numbers; expect them to have moved.
   ------------------------------------------------------------------
   To reproduce the four numbers above without a walk,
   in the page console (they are a static property of the geometry, so
   they do not need this file at all):

     const c = WALLY.ctx, T = WALLY.THREE, x = -24.02, z = -200.18;
     c.phys.player.teleport(new T.Vector3(x, c.phys.groundAt(x,z).y+0.3, z));
     // ...one frame, then teleport again: the collision window streams
     const g = c.phys.groundAt(x, z);
     const r = new T.Raycaster(new T.Vector3(x, g.y+0.45, z), new T.Vector3(0,-1,0), 0, 6);
     // intersect the same roots collectTargets() below uses, then
     // err = g.y - hit.y - 0.34*(1/Math.max(g.normal.y,0.5) - 1)
   ------------------------------------------------------------------ */

/* Probe-disc raster, metres. See "AT HALF A METRE" below for why it is
   not 1.0 any more and not 0.25 either. `--step n` is there so anyone
   can re-run the old grid against the same build and watch it miss. */
const PROBE_STEP = (() => {
  const i = process.argv.indexOf('--step');
  return i > -1 && process.argv[i + 1] ? +process.argv[i + 1] : 0.5;
})();

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
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
let pageErr = null;
page.on('pageerror', (e) => { pageErr = e.message.split('\n')[0]; console.log('PAGEERROR', pageErr); });

await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(4000);

/* The tolerances are Node-side constants and this block runs in the
   page, so they are handed across explicitly — the count added below
   needs them and referencing them directly threw ReferenceError on the
   first leg. */
await page.evaluate(([SINK_TOL, FLOAT_TOL]) => {
  const c = window.WALLY.ctx;
  const T = window.WALLY.THREE;
  const phys = c.phys;

  const frames = (n) => new Promise((res) => {
    let k = 0;
    const tick = () => (++k >= n ? res() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });

  /* ----------------------------------------------------------------
     What counts as "the ground you can see".

     Roots, not a scene-wide traverse: the walkable world is the world
     module's ground group (heightfield, road ribbons, rock) and the
     city root (foundations, berms, plaza pads, piers, steps).
     Everything else in the scene is either not ground (canopies, cloth,
     the sky dome, Wally himself) or actively lies about it — an outline
     hull is the same mesh pushed 2 mm along its normals, and a contact
     shadow is a dome that deliberately breaks through the surface.

     THE SOD LIP IS GONE FROM THIS TREE, AND THE SKIP AND THE BOUND
     BOTH STAY.

     terrain.js used to draw sod tongues overhanging the brinks. They
     were in groundGroup, so this counted them as drawn ground, and
     they had no collider — every one of them a sink past SINK_TOL if
     a probe disc happened to land on one. They were skipped as grass,
     and the bound at the bottom of this file is what made that skip a
     measurement rather than an opinion. The feature was deleted as
     art (see the block where it used to live in terrain.js), so on
     this tree __lip() returns null and the assertion passes on "no
     lip group".

     NEITHER THE NAME IN THE SKIP NOR THE ASSERTION MAY GO WITH IT.
     This suite is run against archives of older commits — that is how
     the numbers below were got — and every one of those trees still
     builds the tongues. Drop `\blip\b` and the archive run counts
     them as drawn ground; drop the assertion and the archive run stops
     failing on them. The blade is 0.24 m and stays 0.24 m.

     THE NUMBERS, EVERY ONE FROM __lip() AND THE WALK BESIDE IT, over
     every vertex of the merged lip meshes with proud = y - ground and
     walkable = normal.y >= cos 48 deg — the controller's own limit:

       (a) "482 of 748 tongues stand proud of walkable ground" was two
           builds in one sentence: 748 is HEAD's tongue count and 482
           is neither build's number. Re-measured against builds served
           from disk — HEAD, 577 of its 748 tongues past 0.12 m (583
           past 0), worst 16.94 m at (254, 326). The build the judge
           looked at was never committed, so it was RECONSTRUCTED by
           putting its three rules back (no shore rejection, no shrink
           gate, the fixed lift instead of the turf plane): it
           reproduced that build's 483 tongues exactly and stood 323 of
           them past 0.12 m, worst 8.59 m at (180, -239). The last
           build to draw tongues — 80 of them — put 25 vertices of
           10,800 over walkable ground at all, 3 of them past 0.12 m,
           worst 0.172 m at (189, -135).

           EVERY NUMBER IN THE PARAGRAPH ABOVE CAME OFF THE OLD
           INSTRUMENT — raster-only ground, positions read without the
           world matrix, and one count printed under the other's name.
           Re-run on a clean HEAD archive with the corrected one, HEAD
           stands 13,478 of its 100,980 vertices over walkable ground
           at all and 12,404 of those past 0.12 m, worst 16.324 m at
           (253, 326.5) — not 16.94, because 2,428 of HEAD's lip
           vertices turn out to sit over drawn road/city/rock ground
           that is HIGHER than the raster beneath it, and that vertex
           is one of them. The tongue counts and the vertex counts are
           different units and both are quoted deliberately. The
           80-tongue build was deleted in the same change that fixed
           the instrument, so its three figures were never re-measured
           with the corrected one and are labelled rather than trusted.

           AND A LINE HERE ONCE DID NOT REPRODUCE, which is the reason
           to distrust a number nobody re-ran. It read "113 tongues,
           FOUR vertices of 15255 over walkable ground at all, 2 of
           them past 0.12 m" — and on that same tree the tongue count,
           the vertex count and the worst vertex were all exactly right
           while the counts were not: __lip() returned NINE past
           0.12 m and 15 over walkable ground at all. Both numbers sat
           far under BLADE either way, so the assertion passed and
           nothing ever forced the re-measurement.

           THE PRINTED LINE USED TO CONTRADICT THIS BLOCK. __lip()
           counted only the vertices past the tolerance and the console
           called that number "vertices stand over walkable ground", so
           the last run printed 3 where the true over-walkable-ground-
           at-all count was 25 and this block said so. Both counts now
           come back and both are printed.

       (b) "both beach discs miss them" was true at BOTH grids, and the
           sink the claim attached to the lip was never the lip. Same
           two spots, discs cast against the lip meshes alone: HEAD,
           342 and 346 points at 0.5/6 and 4991 and 6021 at 0.25/20 —
           no lip surface over the collision ground in any of the four.
           What HEAD's east-beach disc DOES find at 0.25/20 near
           (484, 0) is -0.449 m on `rock.R2,-1` — the talus block with
           no body, which is the rock census's business and is solid
           on this tree.

       (c) the cantilever sentence — "the part that stands proud is
           over the drop with nothing under it" — was simply false at
           the sand bench under the east cliff, and the judge
           photographed the sheet lying on it.

     WHAT COUNTS AS GROUND HE CAN STAND ON — see __lip(). It used to be
     the terrain raster and nothing else, so road ribbons, plaza pads,
     berms, pier decking and building foundations were invisible to it:
     a tongue standing over a plaza pad was measured against the dirt
     under the pad. The placement rules made that rare, but rare was an
     argument and not a measurement. __lip() now takes the HIGHER of
     the raster and the drawn city/road/rock ground under each vertex,
     and the run prints how many vertices found one so the exclusion is
     a number.
     ---------------------------------------------------------------- */
  /* WORD BOUNDARIES ON `water`, AND HERE IS WHY.
     The district is called the WATERFRONT. A bare /water/ matched
     `ground.zone:waterfront` and `road.zone:waterfront` and threw both
     of them out of the drawn set, so at the harbour this test compared
     a real collision surface against the terrain UNDER the paving and
     reported the collision standing 0.145 m over the drawn ground —
     a defect that did not exist, in a mesh it had refused to look at.
     Every water mesh on the island is `water` or `water.<something>`
     (world/water.js, foam.js, ripples.js), so \bwater\b still excludes
     all of them and stops excluding the district named after them. */
  const SKIP = /outline|hull|contactShadow|cloth|drift|grass|\blip\b|foliage|detail|bush|reed|\bwater\b|sky|cloud/i;
  function collectTargets() {
    const roots = [c.world?.groundGroup, c.city?.root].filter(Boolean);
    const out = [];
    for (const r of roots) {
      r.traverse((o) => {
        if (!o.isMesh && !o.isInstancedMesh) return;
        if (o.userData.isOutlineHull || o.userData.noPrepass) return;
        if (SKIP.test(o.name || '')) return;
        for (let p = o; p; p = p.parent) if (p.visible === false) return;
        out.push(o);
      });
    }
    return out;
  }

  const ray = new T.Raycaster();
  ray.far = 400;
  const DOWN = new T.Vector3(0, -1, 0);
  const ORIGIN = new T.Vector3();

  /**
   * The drawn surface under (x, z), starting the ray just above `from`.
   *
   * THE CEILING MATTERS MORE THAN THE RAY DOES. Cast from high enough to
   * clear the island and the first thing a downward ray finds in a city
   * is a ROOF — which is how the first run of this test reported him
   * sinking sixteen metres into Main Street while he was walking down it
   * perfectly happily. He can only ever be standing on something within
   * a step of his own feet, so that is where the ray starts.
   */
  let drawnOn = '';
  function drawnGround(x, z, from, targets) {
    ORIGIN.set(x, from + 0.45, z);
    ray.set(ORIGIN, DOWN);
    ray.far = 6;
    const hits = ray.intersectObjects(targets, false);
    drawnOn = hits.length ? (hits[0].object.name || '?') : '';
    return hits.length ? hits[0].point.y : null;
  }

  /* Every founded building's footprint, in world space, as a rotated
     rectangle. A door forecourt probe of radius 6 reaches four metres
     INSIDE the shell it is standing in front of, and under a shell the
     first thing a downward ray finds is the floor plate, the doorstep
     or the underside of a porch — drawn geometry half a metre over the
     berm, which the probe then reports as him sinking into a threshold
     no capsule can ever occupy. The margin is the plinth's proud face
     plus the widest sprawl any kit adds to its shell. */
  const FOOT_PAD = 0.7;
  /* AND IT CANNOT GO MUCH HIGHER, because the pad deletes probe points
     and the points it would delete first are the defects. Measured
     against the RAW shell rects, the four threshold defects this suite
     has on record stand 1.004 m (trunkdepot berm stone, -279.06,
     146.26), 1.494, 1.577 and 1.787 m (the three apartment porch-pad
     points) outside the nearest one. The tightest is therefore 0.304 m
     of daylight at this pad — and none at all at 1.0, which would
     delete the very measurement the pad exists to make possible. */
  const foots = [];
  for (const [, rec] of c.city.locations) {
    if (!rec.loc?.size) continue;
    foots.push({
      x: rec.loc.world.x, z: rec.loc.world.z,
      cs: Math.cos(rec.loc.yaw), sn: Math.sin(rec.loc.yaw),
      hw: rec.loc.size.w / 2 + FOOT_PAD, hd: rec.loc.size.d / 2 + FOOT_PAD,
    });
  }
  function insideAShell(x, z) {
    for (const f of foots) {
      const dx = x - f.x, dz = z - f.z;
      if (Math.abs(dx * f.cs - dz * f.sn) > f.hw) continue;
      if (Math.abs(dx * f.sn + dz * f.cs) > f.hd) continue;
      return true;
    }
    return false;
  }

  /**
   * Walk from where he is toward (tx, tz), sampling every frame.
   * Returns the error series plus anything that caught him.
   */
  const bodyName = (id) => phys.world.bodies.get(id)?.opts?.name || (id ? `body${id}` : 'plane');

  window.__walk = async function walk(tx, tz, secs = 6, label = '') {
    const p = phys.player;
    const targets = collectTargets();
    const samples = [];
    let stalled = 0, lastD = Infinity, airborne = 0;
    const catches = [];
    /* CRAB ROUND IT AND CARRY ON. A leg is a beeline across a district
       and a district is full of legitimate walls, so the first thing a
       tree or a lamp post in the line does is end the leg — Rusty Row
       lost 250 of its 420 samples to one trunk on the verge. A player
       would step round it. Three sidesteps per leg, alternating hands,
       each 0.75 s of walking 70 degrees off the bearing; the block is
       still recorded, it just no longer costs the district its
       measurement. A leg that is genuinely walled in runs out of
       sidesteps and stops, as it should. */
    let detour = 0, hand = 1, sidesteps = 0;

    p.setInputFn(() => {
      const q = p.simPosition;
      const dx = tx - q.x, dz = tz - q.z;
      const l = Math.hypot(dx, dz) || 1;
      const ux = dx / l, uz = dz / l;
      if (detour <= 0) return { x: ux, z: uz, run: true };
      const a = hand * 1.22;
      const ca = Math.cos(a), sa = Math.sin(a);
      return { x: ux * ca - uz * sa, z: ux * sa + uz * ca, run: true };
    });

    const n = Math.round(secs * 60);
    for (let i = 0; i < n; i++) {
      await frames(1);
      const q = p.simPosition;
      const d = Math.hypot(tx - q.x, tz - q.z);
      if (d < 1.5) break;
      /* progress, or the same obstacle for a second and a half */
      if (lastD - d < 0.004) stalled++; else stalled = 0;
      lastD = d;
      if (stalled > 90) {
        /* A WALL IS NOT A BUG. Half these legs run straight at a
           building, and being stopped by one is the whole point of the
           collision pass. What matters is being stopped by something he
           should have STEPPED OVER.

           ASK THE CAPSULE, NOT THE RAY. The first version of this asked
           only what groundAt() reports half a metre ahead: within the
           0.35 m step offset and he "had every right to keep walking".
           groundAt() is a downward RAY and it answers with the first
           surface it meets whatever that surface is FACING, so the
           flank of a leaning tree-trunk box — a vertical face, a wall
           by any definition — came back as "ground +0.02 m ahead on
           tree.broadleaf", and the suite reported the starting district
           broken because a tree had stopped him. A lamp post, a bollard
           and a parked bike all read the same way. It is a classifier
           that cannot tell a step from a shin.

           So both halves are asked properly. What is touching him: any
           near-vertical contact on his own capsule that opposes the way
           he is trying to go is a WALL and being stopped by it is
           correct behaviour, whatever the ray says. And the surface
           ahead only counts as a step if it is walkable — the same
           slope limit the controller uses, so a face he could never
           stand on is never called a step he should have taken. */
        const dx = (tx - q.x) / d, dz = (tz - q.z) / d;
        const ahead = phys.groundAt(q.x + dx * 0.55, q.z + dz * 0.55);
        const rise = ahead.y - q.y;
        const COS_LIMIT = Math.cos(48 * Math.PI / 180);   // controller.js slopeLimit
        const A = new T.Vector3(q.x, q.y + p.radius, q.z);
        const B = new T.Vector3(q.x, q.y + p.height - p.radius, q.z);
        let by = '', deepest = 0;
        for (const ct of phys.capsuleCast(A, B, p.radius + 0.10, [])) {
          if (ct.normal.y >= COS_LIMIT) continue;                    // floor
          if (ct.normal.x * dx + ct.normal.z * dz > -0.20) continue; // not in his way
          if (ct.depth > deepest) { deepest = ct.depth; by = bodyName(ct.body); }
        }
        const bad = !by && ahead.hit && rise < 0.35 && ahead.normal.y >= COS_LIMIT;
        catches.push({
          x: +q.x.toFixed(1), z: +q.z.toFixed(1),
          rise: +rise.toFixed(2), on: bodyName(ahead.body), by, bad,
        });
        /* a real wall: step round it and keep measuring the district */
        if (!bad && sidesteps < 3) {
          sidesteps++; hand = -hand; detour = 45;
          stalled = 0; lastD = Infinity;
          continue;
        }
        break;
      }
      if (detour > 0) detour--;
      if (!p.grounded) continue;                 // airborne: nothing to compare
      const dy = drawnGround(q.x, q.z, q.y, targets);
      if (dy === null) continue;
      const g = phys.groundAt(q.x, q.z);
      /* THE CAPSULE IS ROUND AND THE HILL IS NOT FLAT.
         simPosition is the bottom of the capsule AXIS, and a capsule of
         radius r resting on a plane of normal n puts that point
         r*(1/n.y - 1) VERTICALLY above the plane — nothing to do with
         the world being wrong, it is where a sphere touches a slope.
         On a 41-degree face in the Iron Hills that is 0.10 m, and this
         test was reading it as him floating over the ground: measured
         there, groundAt() and the drawn mesh agreed to 0.000 m and the
         whole 0.156 m "float" was the capsule.
         So the lift is subtracted. It is a geometric identity, not a
         tolerance: on the flat it is zero and nothing changes, and
         because it is always positive it makes the SINK test stricter
         on a slope, never looser. The raw figure is kept and printed
         beside it so both are on the record. */
      const lift = p.radius * (1 / Math.max(g.normal.y, 0.5) - 1);
      /* A CAPSULE IN THE AIR IS NOT STANDING ON ANYTHING.

         This file's whole question is "does he stand ON the ground you
         can see", and err = feetY - drawnY only answers it while his
         feet are on something. Between the two they are not: with
         world/ground.js's kerbs in, walking off a 0.10 m footway puts
         him briefly airborne, and one frame of that was reported as a
         0.174 m FLOAT at (-304.8, 186.1) on Rusty Row — a defect the
         same coordinate does not have. Probed statically, the drawn
         terrain and the collision surface there agree to 0.000 m in
         both this build and a clean HEAD archive; he was simply in the
         air, which is what stepping off a kerb is.

         Skipped, not tolerated: a real float is a surface he is
         RESTING on that disagrees with the drawn one, and that is
         still measured on every grounded frame. `airborne` counts the
         skips so the exclusion is a number rather than an argument. */
      /* AND `grounded` IS NOT THE TEST FOR IT.
         controller.js keeps grounded true through coyote time and its
         ground snap, so the frame after he walks off a 0.10 m kerb it
         still reads true — measured at (-304.8, 186.1) on Rusty Row,
         grounded, n.y 0.98, and his feet 0.180 m above the collision
         surface directly under them. Ask phys instead: if the ground it
         reports beneath him is further below his feet than the capsule
         geometry accounts for, he is not resting on it, and comparing
         the drawn floor to feet that are in mid-air measures nothing.

         This cannot hide a real float. A float defect is feet AT the
         collision surface with the drawn one below it — q.y - g.y is
         zero there and the sample is kept and measured, exactly as
         before. */
      if (!p.grounded || q.y - g.y - lift > 0.05) { airborne++; continue; }
      samples.push({
        x: +q.x.toFixed(2), z: +q.z.toFixed(2),
        err: q.y - dy - lift, raw: q.y - dy, lift, ny: g.normal.y,
        sp: p.planarSpeed, on: `${bodyName(g.body)} vs ${drawnOn}`,
      });
    }
    p.setInputFn(null);
    p.setInput({ x: 0, z: 0 });

    let sink = 0, float = 0, sum = 0, overSink = 0, overFloat = 0;
    let worstSink = null, worstFloat = null;
    for (const s of samples) {
      sum += s.err;
      if (s.err < sink) { sink = s.err; worstSink = s; }
      if (s.err > float) { float = s.err; worstFloat = s; }
      /* HOW MANY, NOT JUST HOW BAD. A worst-case on its own cannot tell
         one bad metre from a district that is wrong everywhere, and
         those want completely different fixes. paths.js reasoned about
         exactly this the same way — "17 of 68910 sample points past
         0.12 m" — and this row could not until now. */
      if (s.err < -SINK_TOL) overSink++;
      if (s.err > FLOAT_TOL) overFloat++;
    }
    return {
      label, n: samples.length, airborne, catches, overSink, overFloat,
      mean: samples.length ? +(sum / samples.length).toFixed(3) : null,
      sink: +sink.toFixed(3), float: +float.toFixed(3),
      worstSink, worstFloat,
      end: [+p.simPosition.x.toFixed(1), +p.simPosition.y.toFixed(2), +p.simPosition.z.toFixed(1)],
    };
  };

  /**
   * Put him down at (x, z) and let the streamers catch up.
   *
   * TWICE, DELIBERATELY. Terrain collision is a 3 x 3 window of 64 m
   * tiles that follows the PLAYER and builds one tile a frame, so the
   * groundAt() taken before a cross-island teleport is answered by
   * geometry that is nowhere near (x, z) — it lands him tens of metres
   * out and he spends the whole leg falling. The first hop moves the
   * window; the second one uses it.
   */
  window.__place = async function place(x, z, wait = 30) {
    const p = phys.player;
    p.teleport(new T.Vector3(x, phys.groundAt(x, z).y + 0.1, z));
    await frames(wait);
    p.teleport(new T.Vector3(x, phys.groundAt(x, z).y + 0.1, z));
    await frames(wait);
    return { y: +p.simPosition.y.toFixed(2), grounded: p.grounded };
  };

  /**
   * A static census of collision-vs-drawn error on a disc around him.
   * Each point is probed from the collision height it reports, for the
   * same reason the walk is: a roof, a canopy or a cliff overhead is
   * not the floor.
   */
  window.__disc = function disc(r = 7, step = 1.0) {
    const targets = collectTargets();
    const q = phys.player.simPosition;
    const out = [];
    for (let dx = -r; dx <= r; dx += step) {
      for (let dz = -r; dz <= r; dz += step) {
        if (dx * dx + dz * dz > r * r) continue;
        const x = q.x + dx, z = q.z + dz;
        const g = phys.groundAt(x, z);
        if (!g.hit) continue;
        /* Only the storey he is standing on. groundAt reports the top of
           whatever box is highest under a point, so over a building it
           answers with the ROOF — 5 m of "error" that no character will
           ever stand in. */
        if (Math.abs(g.y - q.y) > 1.5) continue;
        /* THE TOP OF A CRATE IS NOT THE GROUND YOU CAN SEE. The roof
           guard above is the same argument one storey down: groundAt()
           answers with the highest surface under a point, and beside a
           doorway that is routinely the lid of a barrel, the saddle of
           a parked bike or the box of a bollard. They are drawn — but
           they are drawn by props.js, which is not in the ground roots
           this test raycasts, so the ray sails past them to the earth
           underneath and every one of them reads as three-quarters of a
           metre of "float". That is the prop being solid, which is what
           it is for. Every prop and every tree registers itself with
           `prop: true`; the ground under a prop is a question for a
           different test. */
        if (phys.world.bodies.get(g.body)?.opts?.prop) continue;
        /* ...and he has to be able to STAND there — see insideAShell */
        if (insideAShell(x, z)) continue;
        const dy = drawnGround(x, z, g.y, targets);
        if (dy === null) continue;
        out.push({
          x: +x.toFixed(1), z: +z.toFixed(1), err: +(g.y - dy).toFixed(3),
          on: `${bodyName(g.body)} vs ${drawnOn}`,
        });
      }
    }
    return out;
  };

  /**
   * EVERY ROCK, NOT THE ONES A GRID HAPPENED TO LAND ON.
   *
   * A disc is a grid and a grid is luck. The east-beach talus block at
   * (479, 6) was drawn, stood 0.45 m proud of the sand and had no
   * collider at all; rasterised at 0.25 m over an 18 m square, only 47
   * of 5329 points fell in the band where its flank is proud of the
   * sand and still under the probe's 0.45 m ceiling. 0.9 %. The 113-
   * point beach disc therefore found it about half the time, and this
   * suite flickered red and green on it across three rounds before
   * anyone rasterised it.
   *
   * So the invariant it was groping for is asserted directly, over all
   * six hundred rocks at once and without a single ray: A ROCK THAT IS
   * DRAWN STANDING PROUD OF GROUND HE CAN WALK ON HAS A BODY.
   *
   * terrain.js decides that with its own two numbers. This asks the
   * same question on STRICTER ones — the controller's real slope limit
   * instead of the gate's 0.45, and this suite's own SINK_TOL instead
   * of the gate's 0.10 — over the same plan box the gate walked. Both
   * thresholds being tighter is what makes the assertion sound: every
   * point this test calls walkable the gate also calls walkable, and
   * every rise this test calls visible the gate also calls visible, so
   * a correct gate can never be reported here. What it does catch is a
   * gate that asks the wrong QUESTION — the one that shipped asked
   * about the ground under a boulder's anchor point, and a talus block
   * is up to 23 m across.
   */
  window.__rocks = function rocks(tol) {
    const W = c.world;
    if (!W.terrain?.rockGateCensus) return null;
    const COS_LIMIT = Math.cos(48 * Math.PI / 180);   // controller.js slopeLimit
    const n = new T.Vector3();
    const out = [];
    for (const e of W.terrain.rockGateCensus()) {
      if (e.solid || !e.box) continue;
      const [x0, z0, x1, z1] = e.box;
      const dx = (x1 - x0) / 4, dz = (z1 - z0) / 4;
      let worst = null;
      for (let i = 0; i <= 4; i++) {
        for (let j = 0; j <= 4; j++) {
          const x = x0 + dx * i, z = z0 + dz * j;
          W.normalAt(x, z, n);
          if (n.y < COS_LIMIT) continue;
          const proud = e.top - W.heightAt(x, z);
          if (proud <= tol) continue;
          if (!worst || proud > worst.crown) worst = { wx: +x.toFixed(1), wz: +z.toFixed(1), crown: +proud.toFixed(2), ny: +n.y.toFixed(2) };
        }
      }
      if (worst) out.push({ x: e.x, z: e.z, kind: e.kind, why: e.why, anchorNy: e.ny, ...worst });
    }
    out.sort((a, b) => b.crown - a.crown);
    return out;
  };

  /**
   * `m` metres inland from (x, z), along the shore-distance gradient.
   * Used to walk a beach probe out of the surf — see MIN_DISC.
   */
  window.__inland = function inland(x, z, m) {
    const W = c.world;
    const e = 3;
    const gx = (W.shoreDistAt(x + e, z) - W.shoreDistAt(x - e, z)) / (2 * e);
    const gz = (W.shoreDistAt(x, z + e) - W.shoreDistAt(x, z - e)) / (2 * e);
    const n = Math.hypot(gx, gz) || 1;
    return { x: x + (gx / n) * m, z: z + (gz / n) * m };
  };

  /**
   * THE SOD LIP, MEASURED RATHER THAN ARGUED — see the SKIP block.
   *
   * The lip is drawn ground with no collider, so it is skipped above;
   * what makes that skip honest is that no part of it stands over
   * ground he can walk on by more than the height of the grass beside
   * it. Every vertex of the merged meshes, against the same 48-degree
   * limit the controller uses. Returns null where there is no lip
   * group — which is this tree, and is not most of the trees this is
   * run against.
   *
   * TWO COUNTS, NOT ONE. `overAll` is every vertex standing over
   * walkable ground at all; `over` is the subset past SINK_TOL. The
   * console used to print `over` and call it `overAll`, so a run said
   * "3 of 10800 vertices stand over walkable ground" while the block
   * above said 25 — the tool contradicting its own documentation.
   *
   * GROUND HE CAN STAND ON IS NOT ONLY THE RASTER. heightAt/normalAt
   * describe the heightfield; a road ribbon, a plaza pad, a berm, pier
   * decking or a building foundation is drawn ground he stands on that
   * the raster has never heard of, and measuring a tongue over a plaza
   * pad against the dirt beneath the pad overstates how proud it is
   * and can call walkable ground unwalkable. So each vertex takes the
   * HIGHER of the raster and a downward ray against the same drawn
   * ground collectTargets() uses, minus the heightfield's own tiles
   * (heightAt already is those, exactly, and cheaply). `onDeck` counts
   * the vertices that found one, so what used to be an argument about
   * how rare this is comes back as a number.
   *
   * AND THE WORLD MATRIX IS APPLIED. Every lip matrix is identity
   * today, so reading positions raw happened to be right; a merged
   * group that is ever parented or offset would have made this quietly
   * measure the wrong island.
   */
  window.__lip = function lip() {
    const g = c.world?.terrain?.lipGroup;
    if (!g) return null;
    const W = c.world;
    const COS = Math.cos(48 * Math.PI / 180);
    const n = new T.Vector3(), v = new T.Vector3();
    const from = new T.Vector3(), DOWN = new T.Vector3(0, -1, 0);
    const nrm = new T.Matrix3();
    /* The heightfield's own tiles are `terrain.<i>.<j>`; heightAt() is
       already their surface, so raying them would only buy float
       noise. Everything else collectTargets() keeps is ground drawn by
       somebody other than the raster. */
    const decks = collectTargets().filter((o) => !/^terrain\.\d+\.\d+$/.test(o.name || ''));
    const deckRay = new T.Raycaster();
    deckRay.far = 30;
    let verts = 0, overAll = 0, over = 0, onDeck = 0, worst = 0, wx = 0, wz = 0;
    g.traverse((o) => {
      if (!o.isMesh) return;
      o.updateMatrixWorld(true);
      const P = o.geometry.attributes.position;
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(o.matrixWorld);
        verts++;
        let gy = W.heightAt(v.x, v.z);
        W.normalAt(v.x, v.z, n);
        let ny = n.y;
        if (decks.length) {
          from.set(v.x, v.y + 0.05, v.z);
          deckRay.set(from, DOWN);
          const hit = deckRay.intersectObjects(decks, false)[0];
          if (hit && hit.point.y > gy) {
            gy = hit.point.y;
            onDeck++;
            if (hit.face && hit.object) {
              nrm.getNormalMatrix(hit.object.matrixWorld);
              ny = n.copy(hit.face.normal).applyMatrix3(nrm).normalize().y;
            } else ny = 1;
          }
        }
        const pr = v.y - gy;
        if (pr <= 0) continue;
        if (ny < COS) continue;
        overAll++;
        if (pr > 0.12) over++;                  // SINK_TOL, node-side
        if (pr > worst) { worst = pr; wx = v.x; wz = v.z; }
      }
    });
    return {
      verts, overAll, over, onDeck, decks: decks.length,
      worst: +worst.toFixed(3), at: [+wx.toFixed(1), +wz.toFixed(1)],
    };
  };

  window.__route = function route() {
    const W = c.world;
    const pts = [];
    for (const id of Object.keys(W.zones)) {
      const z = W.zones[id];
      pts.push({ id, x: z.world.x, z: z.world.z, r: z.world.radius });
    }
    return pts;
  };
}, [SINK_TOL, FLOAT_TOL]);

const zones = await page.evaluate(() => window.__route());
const legs = [];
/* ONE LEG PER DISTRICT, NOT TWO. Twenty cross-island teleports, each
   rebuilding the terrain collision window and a hundred foliage chunks,
   reliably killed the SwiftShader renderer about two thirds of the way
   through the run. Ten legs of 24 m sample four thousand points, which
   is plenty, and the run survives. */
for (const z of zones) {
  const r = Math.min(12, z.r * 0.5);
  legs.push({ label: z.id, from: [z.x - r, z.z - r], to: [z.x + r, z.z + r] });
}

console.log('--- walking the districts ---');
const runs = [];
for (const leg of legs) {
  const at = await page.evaluate(([x, z]) => window.__place(x, z), leg.from);
  const r = await page.evaluate(([x, z, l]) => window.__walk(x, z, 7, l), [...leg.to, leg.label]);
  r.placed = at;
  runs.push(r);
  const flag = (r.sink < -SINK_TOL || r.float > FLOAT_TOL) ? '\x1b[31m' : '';
  console.log(`   ${flag}${leg.label.padEnd(22)}\x1b[0m ` +
    `${String(r.n).padStart(4)} samples  mean ${String(r.mean).padStart(6)}  ` +
    `sink ${r.sink.toFixed(3).padStart(7)}  float ${r.float.toFixed(3).padStart(6)}` +
    `${(r.overSink || r.overFloat) ? `  \x1b[33m(${r.overSink} of ${r.n} past sink, ${r.overFloat} past float)\x1b[0m` : ''}` +
    `${r.airborne ? `  \x1b[90m(${r.airborne} airborne frames skipped)\x1b[0m` : ''}` +
    `${r.n === 0 ? '  \x1b[33mNO SAMPLES\x1b[0m' : ''}`);
  for (const ct of r.catches) {
    console.log(`        ${ct.bad ? '\x1b[31mCAUGHT' : '\x1b[90mstopped'}\x1b[0m at ${ct.x},${ct.z} — ` +
      `${ct.by ? `blocked by ${ct.by}; ` : ''}` +
      `ground ${ct.rise >= 0 ? '+' : ''}${ct.rise} m ahead on ${ct.on}` +
      `${ct.bad ? '  (inside the 0.35 m step offset, nothing in his way — he should have walked on)' : ''}`);
  }
  if (r.worstSink && r.sink < -SINK_TOL) {
    console.log(`        \x1b[33mworst sink\x1b[0m ${r.sink.toFixed(3)} m at ${r.worstSink.x},${r.worstSink.z} on ${r.worstSink.on}` +
      `  (raw ${r.worstSink.raw.toFixed(3)}, capsule lift ${r.worstSink.lift.toFixed(3)} on n.y ${r.worstSink.ny.toFixed(2)})`);
  }
  if (r.worstFloat && r.float > FLOAT_TOL) {
    console.log(`        \x1b[33mworst float\x1b[0m ${r.float.toFixed(3)} m at ${r.worstFloat.x},${r.worstFloat.z} on ${r.worstFloat.on}` +
      `  (raw ${r.worstFloat.raw.toFixed(3)}, capsule lift ${r.worstFloat.lift.toFixed(3)} on n.y ${r.worstFloat.ny.toFixed(2)})`);
  }
}

/* ------------------------------------------------------------------
   The awkward surfaces, probed as static discs so a single bad pad or
   a decking seam cannot hide between two walk samples.

   AT HALF A METRE, BECAUSE A METRE STEPS OVER REAL DEFECTS — AND NOT
   AT A QUARTER, BECAUSE THAT STOPS MEASURING SURFACES.

   The 1 m grid is 87 points on a 6 m disc and it walked straight past
   both threshold defects the last round handed on. Tightened to 0.5 m
   the same two discs are 347 and 342 points and they find four:

     apartment  (-364.28, 201.53)  -0.310   (-365.78, 198.53) -0.280
                (-367.28, 196.53)  -0.201
     trunkdepot (-279.06, 146.26)  -0.146

   two objects, both now solid: the stone pad under a porch post (see
   the porch block in buildings.js) and a berm rubble stone (see
   groundBerm here). It costs four times the rays on six discs and
   nothing else in the run changes.

   Tightened AGAIN to 0.25 m the discs are 1402 and 1387 points and the
   whole suite has exactly one point left in it:

     apartment  (-364.28, 201.78)  +0.310  city.step vs home.rusty.wall

   which is a corner of the porch pad's own collision box. The pad is
   DRAWN as a boxRound with a 0.06 m chamfer and COLLIDED as a square
   box, so the proxy's corner stands about five centimetres of plan
   outside the moulding's, and a quarter-metre raster eventually lands
   a point in that sliver — a sliver a 0.35 m capsule cannot occupy.
   Every one of the city's 2097 collision volumes is a box proxy for a
   chamfered drawn box, so below half a metre this disc is measuring
   chamfer radii and not ground, and it will go on finding them for as
   long as the proxies are boxes. Making them exact is a real job — the
   way the berm rubble and the terrain rock are done, their own
   triangles — and it is not this one. `--step 0.25` shows it to
   whoever takes it on.
   ------------------------------------------------------------------ */
console.log(`--- the awkward surfaces (${PROBE_STEP} m raster) ---`);
const spots = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const W = c.world;
  const out = [];
  /* a beach: walk out from the island centre until the shore is close.
     `inland` lets the node side walk it back out of the surf — see
     MIN_DISC. */
  for (let a = 0; a < 6.28; a += 0.9) {
    for (let r = 40; r < 520; r += 6) {
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (W.heightAt(x, z) < 0.2) break;
      if (W.shoreDistAt(x, z) < 5) { out.push({ id: 'beach', x, z, inland: true }); break; }
    }
    if (out.filter((o) => o.id === 'beach').length >= 2) break;
  }
  /* plaza + pavement: the door forecourt of a main-street building */
  for (const [id, rec] of c.city.locations) {
    if (!rec.door) continue;
    const ax = Math.sin(rec.loc.yaw), az = Math.cos(rec.loc.yaw);
    if (rec.kit === 'pier') out.push({ id: `pier deck (${id})`, x: rec.door.x + ax * 2, z: rec.door.z + az * 2 });
    else if (out.filter((o) => o.id.startsWith('threshold')).length < 2) {
      out.push({ id: `threshold (${id})`, x: rec.door.x + ax * 2.2, z: rec.door.z + az * 2.2 });
    }
  }
  return out;
});

/* A DISC THIS THIN IS NOT EVIDENCE — AND NEITHER IS ONE HE IS FALLING
   THROUGH.

   The second beach probe stands where the shore scan first comes
   within 5 m of the waterline, which is IN the surf — half the disc is
   sea, groundAt() has nothing to answer with there, and what is left
   depends on where the teleport happened to settle him. Across six
   runs it has come back with 58, 116, 151, 183, 193 and 225 usable
   points against the first beach disc's steady ~308, and on two of
   them he was not grounded when the disc was cast. This suite already
   knows what a thin disc is worth: the rock census exists because a
   113-point disc found the east-beach talus block about half the time,
   and 58 is half of that again.

   So a probe that cannot raise 150 points, OR that catches him off the
   ground, walks inland along the shore-distance gradient, 4 m at a
   time, until it can — the distance it walked is printed beside the
   count, and a probe that never gets there fails the run instead of
   quietly passing it. Both halves are needed: 151 points cleared the
   floor on one run with `grounded` false, and a disc measured around a
   player who is still settling is a disc measured against a q.y that
   the 1.5 m storey filter is being applied to. */
const MIN_DISC = 150;

const probes = [];
for (const s of spots) {
  let at = { x: s.x, z: s.z }, walked = 0, d = [], put = null;
  for (;;) {
    put = await page.evaluate(([x, z]) => window.__place(x, z), [at.x, at.z]);
    d = await page.evaluate((step) => window.__disc(6, step), PROBE_STEP);
    if ((d.length >= MIN_DISC && put.grounded) || !s.inland || walked >= 16) break;
    walked += 4;
    at = await page.evaluate(([x, z, m]) => window.__inland(x, z, m), [s.x, s.z, walked]);
  }
  if (!d.length) { console.log(`   ${s.id.padEnd(26)} no drawn ground found`); continue; }
  let lo = 0, hi = 0, loOn = '', hiOn = '';
  for (const p of d) {
    if (p.err < lo) { lo = p.err; loOn = p.on; }
    if (p.err > hi) { hi = p.err; hiOn = p.on; }
  }
  probes.push({ id: s.id, lo, hi, n: d.length, loOn, hiOn, walked, grounded: !!put?.grounded });
  const flag = (lo < -SINK_TOL || hi > FLOAT_TOL || d.length < MIN_DISC || !put?.grounded) ? '\x1b[31m' : '';
  console.log(`   ${flag}${s.id.padEnd(26)}\x1b[0m ${String(d.length).padStart(4)} pts  ` +
    `collision below drawn ${lo.toFixed(3).padStart(7)} (${loOn || '-'})  ` +
    `above ${hi.toFixed(3).padStart(6)} (${hiOn || '-'})` +
    `${put?.grounded ? '' : '  \x1b[31m(not grounded)\x1b[0m'}` +
    `${walked ? `  \x1b[90m(walked ${walked} m inland for the points)\x1b[0m` : ''}`);
}

/* ------------------------------------------------------------------
   The rock census: exhaustive, deterministic, and not a grid. See
   __rocks() for why a probe disc is the wrong instrument for this.
   ------------------------------------------------------------------ */
console.log('--- drawn rock without a body ---');
const orphans = await page.evaluate((tol) => window.__rocks(tol), SINK_TOL);
if (orphans === null) {
  console.log('   \x1b[31mterrain.rockGateCensus() is missing — the invariant cannot be checked\x1b[0m');
} else if (!orphans.length) {
  console.log('   \x1b[90mnone — every rock proud of walkable ground is solid\x1b[0m');
} else {
  for (const o of orphans.slice(0, 8)) {
    /* `crown` is the top of the rock's bounding box against the ground
       at the walkable sample — an upper bound on how deep he could
       stand in it, not the sink itself. It is the honest figure for
       "this thing is drawn over ground he can reach"; the sink is what
       the disc and the walk measure. */
    console.log(`   \x1b[31m${o.kind.padEnd(6)}\x1b[0m at ${o.x},${o.z} — crown stands ${o.crown} m over walkable ` +
      `ground at ${o.wx},${o.wz} (n.y ${o.ny}), no body; ` +
      `gate rejected on \x1b[33m${o.why}\x1b[0m (anchor n.y ${o.anchorNy})`);
  }
  if (orphans.length > 8) console.log(`   ...and ${orphans.length - 8} more`);
}

/* ------------------------------------------------------------------
   The sod lip: skipped above as grass, and bounded here so the skip
   is a measurement rather than an opinion. 0.24 m is the tallest
   blade in grass.js's field (0.11-0.24, mean 0.16) — the height of
   the thing he already walks through without noticing.
   ------------------------------------------------------------------ */
const BLADE = 0.24;
console.log('--- sod lip over walkable ground ---');
const lip = await page.evaluate(() => window.__lip());
if (lip === null) {
  console.log('   \x1b[90mno lip group — nothing to bound (terrain.js draws no sod tongues on this tree)\x1b[0m');
} else if (!lip.overAll) {
  console.log(`   \x1b[90m${lip.verts} vertices, not one of them over walkable ground at all\x1b[0m`);
} else {
  /* BOTH COUNTS. `overAll` is over walkable ground at all; `over` is
     the subset past the tolerance. Printing the second under the first
     one's name is what made this line contradict the SKIP block. */
  const f = lip.worst > BLADE ? '\x1b[31m' : '\x1b[90m';
  console.log(`   ${f}${lip.overAll} of ${lip.verts} vertices stand over walkable ground at all, ` +
    `${lip.over} of them past ${SINK_TOL} m; worst ${lip.worst} m at ${lip.at[0]},${lip.at[1]}\x1b[0m`);
}
if (lip !== null) {
  console.log(`   \x1b[90mwalkable ground here is the raster plus ${lip.decks} drawn road/city/rock ground meshes; ` +
    `${lip.onDeck} vertices stood over one of those rather than over the raster\x1b[0m`);
}

/* ------------------------------------------------------------------ */
const worstSink = Math.min(...runs.map((r) => r.sink), 0);
const worstFloat = Math.max(...runs.map((r) => r.float), 0);
const caught = runs.filter((r) => r.catches.some((ct) => ct.bad)).map((r) => r.label);
const badProbes = probes.filter((p) => p.lo < -SINK_TOL || p.hi > FLOAT_TOL).map((p) => p.id);

const results = [
  [`he never sinks more than ${SINK_TOL} m into the drawn ground`, worstSink > -SINK_TOL, `worst ${worstSink.toFixed(3)} m`],
  [`he never floats more than ${FLOAT_TOL} m over it`, worstFloat < FLOAT_TOL, `worst ${worstFloat.toFixed(3)} m`],
  ['no leg is stopped by something he should walk over', caught.length === 0, caught.length ? caught.join(', ') : 'none'],
  ['the awkward surfaces agree with what is drawn', badProbes.length === 0,
    badProbes.length ? badProbes.join(', ') : `all within tolerance on a ${PROBE_STEP} m raster`],
  ['every probe disc is thick enough to be evidence, and he is standing on it',
    probes.every((p) => p.n >= MIN_DISC && p.grounded),
    probes.map((p) => p.n + (p.grounded ? '' : '!')).join('/') + ` points, floor ${MIN_DISC}` +
      (probes.every((p) => p.grounded) ? '' : ', ! = not grounded')],
  ['no sod tongue stands over walkable ground by more than a blade of grass',
    lip === null || lip.worst <= BLADE,
    lip === null ? 'no lip group' : `worst ${lip.worst} m against a ${BLADE} m blade`],
  ['every rock drawn proud of walkable ground has a body',
    Array.isArray(orphans) && orphans.length === 0,
    orphans === null ? 'terrain.rockGateCensus() missing'
      : orphans.length ? `${orphans.length} drawn without one, worst crown ${orphans[0].crown} m at ${orphans[0].x},${orphans[0].z}`
        : 'all solid'],
  ['no page errors', pageErr === null, pageErr || 'clean'],
];

await browser.close();
server.close();

console.log('\n=== surfacetest ===');
let bad = 0;
for (const [name, pass, note] of results) {
  if (!pass) bad++;
  console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}\x1b[90m — ${note}\x1b[0m`);
}
console.log(bad ? `\x1b[31m${bad} failed\x1b[0m` : '\x1b[32mall green\x1b[0m');
process.exit(bad ? 1 : 0);
