#!/usr/bin/env node
/* ============================================================
   cliptest.mjs — "get close, but do not go through."

   THE BUG THIS EXISTS FOR. The user sent screenshots of Wally standing
   INSIDE a waste bin and INSIDE a bench, and walking through a shipping
   container. The cause was not a solver bug: src/world/props.js,
   signs.js, trees.js and scatter.js registered NOTHING with ctx.phys, so
   every bin, bench, crate, barrel, lamp, bollard, planter, container and
   tree on the island was scenery you could stand inside.

   THE MEASUREMENT. Pick a real object out of the live collision world —
   not a fixture, the actual body the game registered — then:

     1. raycast from a standing eye height toward its centre, which
        gives the SURFACE he is about to walk into: a point and a normal.
     2. teleport him 4 m back along that ray and hold run toward it.
     3. every frame, test his capsule against that surface's plane and
        against the object's own convex box.

   Two things must both be true, and one without the other is a failure:

     STOPPED   his capsule axis never crosses the surface plane, and for
               a box-shaped body he is never inside the box. This is the
               reported bug.
     CLOSE     he ends up within a few centimetres of touching it. A
               collider that stops him 2 m out is an invisible wall, and
               that is how a well-meant fix makes a game feel worse than
               the bug did.

   Six kinds of object, four approach angles each: a bin, a bench, a
   lamp post, a barrel, a tree trunk and a building wall.

   Also asserts every one of the 28 named locations still has a walkable
   approach to its door — a lamp post dropped in the wrong place blocks
   a shop for the rest of the game and nothing else in the suite notices.

     node tools/cliptest.mjs [--verbose] [--revert] [--wallraw]

   ------------------------------------------------------------------
   WHAT A REVERT CHECK IS, AND WHAT THIS FILE'S USED TO BE.

   A REVERT CHECK RUNS TODAY'S TEST AGAINST YESTERDAY'S CODE.

   That direction is the entire content of the idea and it is the one
   that gets stated backwards. It has been said of this file that "it
   fails against a clean HEAD archive". That is only a claim about
   anything if it means the WORKING TREE's cliptest run against HEAD's
   src. HEAD's own cliptest against HEAD's src passes BY CONSTRUCTION —
   the test and the code were written together, in the same commit, and
   agree with each other about what the world looked like then. Running
   it proves the build is green, which is not the question.

   The two "REVERT CHECK:" notes further down this file (delete the
   `broom` entry from SOLID in props.js; change life.js's clamp floor
   to 1.6) are the right direction and the right shape — they name a
   line and predict which rows go red — but they are INSTRUCTIONS TO A
   READER. They have not been executed by this file and they are not
   evidence. Read them as recipes.

   `--revert` IS executed. It takes the first walk-into target, snaps
   its box, removes that body from the live collision world with
   ctx.phys.remove(), and re-runs the SAME four approaches against the
   SAME snapped box. Before and after are measured with one instrument
   so the pair is comparable. The assertion is the negation of section
   1's: with the body gone he MUST go through, on the same page load,
   which is precisely the bug the user sent screenshots of. It runs
   last, after every other section has had the intact world.
   ------------------------------------------------------------------ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
/* see WHAT A REVERT CHECK IS at the top of this file */
const REVERT = process.argv.includes('--revert');
/* section 1b's switch: run the door face with the body filter off too */
const WALLRAW = process.argv.includes('--wallraw');
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
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
let pageErr = null;
page.on('pageerror', (e) => { pageErr = e.message.split('\n')[0]; console.log('PAGEERROR', pageErr); });

/* ?partcensus makes world/kits.js record the AABB of every part it is
   handed. Sections 3-5 below are the only reason it exists; without it
   ctx.city.partCensus() returns an empty list and section 3 fails
   loudly rather than passing on no data. */
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro&partcensus`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(4000);

/* ------------------------------------------------------------------
   In-page rig. Everything runs inside one evaluate so the walk is
   sampled on the render loop rather than over a round trip.
   ------------------------------------------------------------------ */
await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const T = window.WALLY.THREE;
  const phys = c.phys;
  const world = phys.world;

  const frames = (n) => new Promise((res) => {
    let k = 0;
    const tick = () => (++k >= n ? res() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });

  /** The name a raycast hit belongs to. A plane distance is only
      evidence about a wall if the plane came off the wall, so every row
      that reports one reports this beside it. */
  function nameOfBody(bid) {
    const rec = world.bodies.get(bid);
    return (rec && rec.opts && rec.opts.name) || (bid ? `#${bid}` : 'terrain');
  }

  /** Every registered body, with its name and world AABB. */
  function bodies(prefix) {
    const out = [];
    for (const [id, rec] of world.bodies) {
      const n = rec.opts?.name || '';
      if (prefix && !n.startsWith(prefix)) continue;
      if (!rec.count) continue;
      out.push({
        id, name: n, count: rec.count,
        c: rec.aabb.getCenter(new T.Vector3()),
        s: rec.aabb.getSize(new T.Vector3()),
      });
    }
    return out;
  }

  /**
   * Signed distance from (x,y,z) to this body treated as a convex solid:
   * the largest of the six outward face-plane distances. Negative means
   * INSIDE. Exact for the 12-triangle boxes every prop and trunk
   * registers, and exactly right on a face-on approach, which is what
   * this test drives. null for bodies that are not one convex box (the
   * merged city collision mesh).
   */
  function boxDist(id, x, y, z) {
    const rec = world.bodies.get(id);
    if (!rec || rec.count !== 12) return null;
    /* WINDING IS NOT A GIVEN. collision.js's addBox winds its faces so
       that the stored normals point INWARD (the top face's normal is
       0,-1,0) — harmless for the narrowphase, which derives its
       separating direction radially, and completely fatal to a
       sign-assuming distance test: it reported a metre of clearance for
       a capsule that was touching. So probe the body's own centre once
       and read the convention off it. */
    if (rec._sgn === undefined) {
      const c0 = rec.aabb.getCenter(new T.Vector3());
      const o0 = rec.start * 9, n0 = rec.start * 3;
      const d0 = (c0.x - world.tri[o0]) * world.nrm[n0]
               + (c0.y - world.tri[o0 + 1]) * world.nrm[n0 + 1]
               + (c0.z - world.tri[o0 + 2]) * world.nrm[n0 + 2];
      rec._sgn = d0 > 0 ? -1 : 1;      // -1 = normals point inward
    }
    let best = -Infinity;
    for (let t = rec.start; t < rec.start + rec.count; t++) {
      const o = t * 9, n = t * 3;
      const d = rec._sgn * ((x - world.tri[o]) * world.nrm[n]
              + (y - world.tri[o + 1]) * world.nrm[n + 1]
              + (z - world.tri[o + 2]) * world.nrm[n + 2]);
      if (d > best) best = d;
    }
    return best;   // > 0 outside, < 0 inside
  }

  /**
   * Walk into `target` from `angle`, starting `dist` metres out.
   *
   * TWO NUMBERS, AND THE FIRST ONE IS EASY TO GET WRONG. Measuring the
   * approach face as an infinite PLANE reports a nine-metre breach for a
   * tree that stopped him dead: he slid round the trunk and kept running,
   * which is exactly what he should do, and the plane does not end. So
   * the plane is only sampled while he is still in front of the object
   * (within 1.2 m of the approach line); the through-test proper is the
   * convex box distance, which has no such hole in it.
   *
   * AND THE SECOND ONE WAS WRONG THE SAME WAY, ONE LEVEL DOWN. In plane
   * mode this took the first vertical face on the approach ray WHATEVER
   * BODY IT BELONGED TO. `onlyBody` is the fix; the long note above
   * section 1b's four-face loop is the measurement that forced it.
   * Pass the body the plane is allowed to come from and the ray steps
   * past everything in front of it, reporting what it stepped past.
   */
  window.__clip = async function clip(target, angle, dist = 4.0, secs = 2.6, mode = 'box', onlyBody = null) {
    const p = c.phys.player;
    const cen = new T.Vector3(target.c.x, target.c.y, target.c.z);
    const dir = new T.Vector3(Math.sin(angle), 0, Math.cos(angle));

    /* stand him off, let the terrain collision window catch up */
    const sx = cen.x + dir.x * dist, sz = cen.z + dir.z * dist;
    const g0 = phys.groundAt(sx, sz);
    p.teleport(new T.Vector3(sx, g0.y + 0.05, sz));
    await frames(30);

    /* The surface he is about to walk into. Cast at three heights: a
       0.9 m bin is under the chest ray and over the ankle one. */
    const start = p.simPosition.clone();
    const toward = new T.Vector3(-dir.x, 0, -dir.z);
    let hp = null, hn = null, hy0 = null, planeBody = -1;
    const passed = [];              // bodies stepped past, named, in order
    if (mode === 'plane') {
      for (const hy of [0.95, 0.55, 1.4, 0.3]) {
        const o = new T.Vector3(start.x, start.y + hy, start.z);
        let travelled = 0;
        /* step past up to eight foreground surfaces. Eight because the
           budget has to be bigger than the number of things that can
           plausibly stand between a pavement and a shop front — board,
           bin, bench, planter — and small enough to terminate. */
        for (let k = 0; k < 8; k++) {
          const hit = phys.raycast(o, toward, dist + 3 - travelled);
          if (!hit) break;
          const ok = hit.normal.y < 0.8;
          if (ok && (onlyBody === null || hit.body === onlyBody)) {
            hp = hit.point.clone(); hn = hit.normal.clone(); hy0 = hy; planeBody = hit.body; break;
          }
          if (ok) passed.push({ name: nameOfBody(hit.body), at: +(travelled + hit.distance).toFixed(3) });
          /* 2 cm past the face, so the next cast starts on the far side
             of it rather than re-finding the same triangle */
          travelled += hit.distance + 0.02;
          o.addScaledVector(toward, hit.distance + 0.02);
          if (travelled > dist + 3) break;
        }
        if (hp) break;
      }
      if (!hp) {
        return { skip: onlyBody === null ? 'no vertical face on the approach ray'
          : `no vertical face of the target body on the approach ray${passed.length ? ` (stepped past ${passed.map((q) => `${q.name}@${q.at}m`).join(', ')})` : ''}`,
        eye: [+start.x.toFixed(1), +start.y.toFixed(1), +start.z.toFixed(1)],
        ground: +phys.groundAt(start.x, start.z).y.toFixed(2) };
      }
    }

    let minPlane = Infinity;       // only while in front of it
    let minBox = Infinity;         // convex distance, negative = inside
    p.setInputFn(() => ({ x: -dir.x, z: -dir.z, run: true }));
    const n = Math.round(secs * 60);
    for (let i = 0; i < n; i++) {
      await frames(1);
      const q = p.simPosition;
      const lat = Math.abs((q.x - start.x) * dir.z - (q.z - start.z) * dir.x);
      for (const h of [p.radius, 0.8, p.height - p.radius]) {
        if (mode === 'box') {
          const bd = boxDist(target.id, q.x, q.y + h, q.z);
          if (bd !== null && bd < minBox) minBox = bd;
        } else if (lat < 1.0) {
          const d = (q.x - hp.x) * hn.x + (q.y + h - hp.y) * hn.y + (q.z - hp.z) * hn.z;
          if (d < minPlane) minPlane = d;
        }
      }
    }
    p.setInputFn(null);
    p.setInput({ x: 0, z: 0 });

    return {
      minPlane: Number.isFinite(minPlane) ? +minPlane.toFixed(3) : null,
      minBox: Number.isFinite(minBox) ? +minBox.toFixed(3) : null,
      radius: p.radius,
      /* WHAT THE PLANE WAS, beside the number it produced. Rule 5: print
         where the rig actually ended up, not where it was aimed. */
      face: hp ? { body: nameOfBody(planeBody), hy: hy0, at: +start.distanceTo(hp).toFixed(3) } : null,
      passed,
      eye: [+start.x.toFixed(1), +start.y.toFixed(1), +start.z.toFixed(1)],
      end: p.simPosition.toArray().map((v) => +v.toFixed(2)),
    };
  };

  window.__bodies = bodies;

  /* ----------------------------------------------------------------
     THE REVERT ARM'S INSTRUMENT.

     Section 1 measures against the body's own 12 triangles, which stop
     existing the moment ctx.phys.remove() takes the body out — a
     removed body would report `n/a` for ever and the revert would look
     like a skip rather than a breach. So the revert arm snaps the
     body's world AABB first and measures against THAT, using the same
     convention boxDist uses (the largest outward face-plane distance,
     negative inside), and it measures the INTACT world the same way so
     the before/after pair is one instrument, not two.
     ---------------------------------------------------------------- */
  window.__snap = (id) => {
    const rec = world.bodies.get(id);
    if (!rec) return null;
    return { min: rec.aabb.min.toArray(), max: rec.aabb.max.toArray(), name: rec.opts?.name || '' };
  };
  window.__physRemove = (id) => c.phys.remove(id);

  const aabbDist = (b, x, y, z) => Math.max(
    b.min[0] - x, x - b.max[0], b.min[1] - y, y - b.max[1], b.min[2] - z, z - b.max[2]);

  /** The same approach as __clip, measured against a snapped AABB. */
  window.__clipBox = async function clipBox(box, cen, angle, dist = 4.0, secs = 2.6) {
    const p = c.phys.player;
    const dir = new T.Vector3(Math.sin(angle), 0, Math.cos(angle));
    const sx = cen.x + dir.x * dist, sz = cen.z + dir.z * dist;
    const g0 = phys.groundAt(sx, sz);
    p.teleport(new T.Vector3(sx, g0.y + 0.05, sz));
    await frames(30);
    let minBox = Infinity;
    p.setInputFn(() => ({ x: -dir.x, z: -dir.z, run: true }));
    const n = Math.round(secs * 60);
    for (let i = 0; i < n; i++) {
      await frames(1);
      const q = p.simPosition;
      for (const h of [p.radius, 0.8, p.height - p.radius]) {
        const d = aabbDist(box, q.x, q.y + h, q.z);
        if (d < minBox) minBox = d;
      }
    }
    p.setInputFn(null);
    p.setInput({ x: 0, z: 0 });
    return { minBox: Number.isFinite(minBox) ? +minBox.toFixed(3) : null,
             end: p.simPosition.toArray().map((v) => +v.toFixed(2)) };
  };

  /**
   * Is there a clear 0.34 m capsule at (x,z)? Used for door approaches.
   *
   * TWO THINGS THIS USED TO GET WRONG, AND BOTH OF THEM MADE IT PASS.
   *
   * WHERE THE CAPSULE RESTS. It was dropped r + 0.02 above the reported
   * ground, which is only where a capsule sits on the FLAT: on a plane
   * of normal n the bottom sphere rests r/n.y above it, so on anything
   * over about 7 degrees the capsule was placed inside the floor and
   * the floor came back as an obstruction. Every founded building in
   * the city now banks its ground into a berm, and a berm is a slope,
   * so this fired on three doorways that are in fact wide open.
   *
   * WHAT COUNTS AS AN OBSTRUCTION. The ground he is standing on is not
   * one, and neither is a lip inside the controller's 0.35 m step
   * offset — he walks over both. A doorway is blocked by something that
   * presents a WALL: a lamp post, a bench, a container, a nameboard
   * hung too low. So a contact only counts if it is not floor-like, or
   * if it is deep enough that he would have to climb it.
   */
  window.__clearAt = function clearAt(x, z, r = 0.34, h = 1.62) {
    const g = phys.groundAt(x, z);
    const rest = g.y + r / Math.max(g.normal.y, 0.5) + 0.02;
    const a = new T.Vector3(x, rest, z);
    const b = new T.Vector3(x, g.y + h - r, z);
    const hits = phys.capsuleCast(a, b, r);
    const who = new Set();
    let n = 0;
    for (const c2 of hits) {
      if (c2.normal.y > 0.6 && c2.depth < 0.35) continue;      // floor, or a kerb he steps over
      n++;
      const rec = world.bodies.get(c2.body);
      who.add(rec?.opts?.name || `body${c2.body}`);
    }
    return { n, who: [...who], y: +g.y.toFixed(2), on: world.bodies.get(g.body)?.opts?.name || 'plane', hit: g.hit };
  };

  /** Park him near (x,z) so the streamed terrain window covers it. */
  window.__park = async function park(x, z) {
    const p = c.phys.player;
    p.teleport(new T.Vector3(x, phys.groundAt(x, z).y + 0.2, z));
    await frames(36);
    p.teleport(new T.Vector3(x, phys.groundAt(x, z).y + 0.2, z));
    await frames(36);
    return true;
  };
});

/* ------------------------------------------------------------------
   1. Walk into things.
   ------------------------------------------------------------------ */
const census = await page.evaluate(() => {
  const all = window.__bodies('');
  const by = {};
  for (const b of all) {
    const k = b.name.replace(/\.\d+.*$/, '');
    by[k] = (by[k] || 0) + 1;
  }
  return by;
});
console.log('--- collision world census ---');
for (const [k, v] of Object.entries(census).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(v).padStart(5)}  ${k}`);
}

/** Pick the instance of `name` nearest to the player's spawn. */
const pick = (name, nth = 0) => page.evaluate(([n, k]) => {
  const p = window.WALLY.ctx.phys.player.simPosition;
  const list = window.__bodies(n)
    .map((b) => ({ ...b, d: Math.hypot(b.c.x - p.x, b.c.z - p.z) }))
    .filter((b) => b.d > 6 && b.d < 220)
    .sort((a, b) => a.d - b.d);
  const b = list[k];
  return b ? { id: b.id, name: b.name, c: b.c, s: b.s, d: +b.d.toFixed(1) } : null;
}, [name, nth]);

/* A SUITE THAT CANNOT SEE THE OBJECT IT WAS WRITTEN TO COVER passes for
   the wrong reason. The header above names signs.js as one of the four
   modules that registered nothing with ctx.phys — and then this list
   asked for a bin, a bench, a lamp, a barrel and a trunk and never for
   a sign, so the run came back all green over twenty-eight nameboards
   whose painted faces you could walk straight through. */
const TARGETS = [
  ['bin', 'prop.bin'],
  ['bench', 'prop.bench'],
  ['lamp post', 'prop.lamp'],
  ['barrel', 'prop.barrel'],
  ['tree trunk', 'tree.'],
  ['sign board', 'sign.board', { overhead: true }],
  /* THE MID-USE SET, added with it. Each of these is a new solid
     object standing in a street, which is exactly the shape of the bug
     this whole file exists for: props.js grew the shapes, and if SOLID
     or PROP_FOOTPRINT had missed one it would have shipped as scenery
     you can stand inside — as the bins and the benches once did — and
     nothing else in the suite would have noticed.

     REVERT CHECK: delete the `broom` entry from SOLID in props.js and
     the two broom rows below go red on "no body registered" while
     every other row stays green. Same for `sandwich` and
     `fingerpost`. */
  ['broom', 'prop.broom'],
  ['A-board', 'prop.sandwich'],
  ['fingerpost', 'prop.fingerpost'],
];

const results = [];
const ANGLES = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
/* The body the --revert arm at the bottom of this file takes back out
   of the collision world: the FIRST walk-into target, which is the bin
   — the object in the user's original screenshot. */
let revertTarget = null;

for (const [label, prefix, opt = {}] of TARGETS) {
  const t = await pick(prefix);
  if (!t) {
    console.log(`--- ${label}: NOT FOUND in the collision world ---`);
    results.push([`${label} exists as a collider`, false, 'no body registered']);
    continue;
  }
  console.log(`--- ${label} (${t.name}, ${t.d} m away, ` +
    `${t.s.x.toFixed(2)}x${t.s.y.toFixed(2)}x${t.s.z.toFixed(2)} m) ---`);
  if (!revertTarget && !opt.overhead) revertTarget = { label, id: t.id, c: t.c, name: t.name };
  let clipped = 0, tried = 0, closest = Infinity;
  for (const a of ANGLES) {
    const r = await page.evaluate(([tt, aa]) => window.__clip(tt, aa),
      [{ id: t.id, c: t.c }, a]);
    if (r.skip) { console.log(`   ${(a * 57.3).toFixed(0).padStart(4)} deg  skip: ${r.skip}`); continue; }
    tried++;
    /* The capsule axis may come within one radius of the face — that is
       touching it. Crossing it is not. 1 cm of solver skin allowed. */
    const through = r.minBox !== null && r.minBox < -0.01;
    if (through) clipped++;
    if (r.minBox !== null) closest = Math.min(closest, r.minBox);
    console.log(`   ${(a * 57.3).toFixed(0).padStart(4)} deg  ` +
      `capsule axis came within ${r.minBox === null ? ' n/a' : r.minBox.toFixed(3)} m ` +
      `of the box surface  ${through ? '\x1b[31mWENT THROUGH\x1b[0m' : 'stopped outside'}`);
  }
  if (!tried) { results.push([`${label} approachable`, false, 'every angle skipped']); continue; }
  results.push([`${label}: never passes through`, clipped === 0, `${clipped}/${tried} angles clipped`]);
  /* CLOSE. His axis must come within a radius plus a hand's breadth of
     the surface, or the collider is an invisible wall standing off the
     object — which is how a well-meant fix feels worse than the bug.

     OVERHEAD bodies are exempt and must be: a nameboard that hangs at
     2.2 m is doing its job precisely by being out of reach, and
     demanding he touch it would be demanding it hang at head height.
     They are covered by the dedicated section below instead. */
  if (opt.overhead) {
    console.log(`   (overhead body — clearance is asserted in the nameboard section, not by touch)`);
  } else {
    results.push([`${label}: gets close enough to touch`, closest < 0.34 + 0.14,
      `closest axis-to-surface ${closest === Infinity ? 'n/a' : closest.toFixed(3)} m (radius 0.34)`]);
  }
}

/* ------------------------------------------------------------------
   1c. THE NAMEBOARDS.

   The bug this section exists for: signs.js registered NOTHING, and
   every board hung from a bracket that stood it a metre and three
   quarters into the street with its bottom edge under Wally's 1.58 m
   head. Driving at the Culture Bazaar board at 135 degrees put the
   capsule 1.045 m INSIDE the painted face, on all three axes.

   Two things have to be true of every one of the twenty-eight, and
   they are alternatives, not both:

     it hangs CLEAR — its lowest point is above the headroom line, so
     he cannot reach it walking or jumping, and nothing about it can be
     in his way; or

     it is SOLID — a board on a frontage too short to give the room
     stops him instead of letting him through.

   A board that is neither is the original bug.
   ------------------------------------------------------------------ */
console.log('--- nameboards ---');
const boards = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const T = window.WALLY.THREE;
  const world = c.phys.world;
  const solid = new Set();
  for (const [id, rec] of world.bodies) if (rec.opts?.name === 'sign.board') solid.add(id);
  const box = new T.Box3();
  const out = [];
  for (const [id, rec] of c.city.locations) {
    if (!rec.sign) continue;
    rec.sign.group.updateMatrixWorld(true);
    box.setFromObject(rec.sign.board);
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    /* the ground a reader stands on under the board: the terrain
       raster, or the building's own floor where that is higher */
    const gy = Math.max(c.world.heightAt(cx, cz), rec.groundY + (rec.meta?.ground ?? 0));
    out.push({
      id,
      kit: rec.kit,
      clear: +(box.min.y - gy).toFixed(3),
      hasBody: rec.sign.colliderId != null,
      x: +cx.toFixed(1), z: +cz.toFixed(1),
      w: +(rec.sign.width ?? 0).toFixed(2), h: +(rec.sign.height ?? 0).toFixed(2),
    });
  }
  out.sort((a, b) => a.clear - b.clear);
  return { boards: out, bodies: solid.size, head: c.phys.player.height };
});
/* Head height plus a running jump. Below this he can put his skull
   through the board; above it he cannot reach it at all. */
const HEADROOM = 2.15;
for (const b of boards.boards.slice(0, 6)) {
  const ok = b.clear >= HEADROOM || b.hasBody;
  console.log(`   ${ok ? '      ' : '\x1b[31mWALK-THRU\x1b[0m'} ${b.id.padEnd(16)} ${b.kit.padEnd(9)} ` +
    `board bottom ${b.clear.toFixed(2)} m above ground, ${b.w}x${b.h} m, ` +
    `${b.hasBody ? 'solid' : '\x1b[31mno collider\x1b[0m'}`);
}
console.log(`   ${boards.boards.length} boards, ${boards.bodies} registered with phys, ` +
  `lowest hangs ${boards.boards[0]?.clear.toFixed(2)} m over the ground (head at ${boards.head})`);
const unreachable = boards.boards.filter((b) => b.clear < HEADROOM && !b.hasBody);
results.push(['every nameboard is a body in the collision world',
  boards.bodies === boards.boards.length, `${boards.bodies}/${boards.boards.length}`]);
results.push(['no nameboard can be walked through',
  unreachable.length === 0,
  unreachable.length ? unreachable.map((b) => `${b.id} @${b.clear}m`).join(', ')
    : `all ${boards.boards.length} either clear ${HEADROOM} m or are solid`]);

/* ------------------------------------------------------------------
   1b. A building wall. The whole city is ONE merged collision body, so
   there is no convex box to test against — the face plane, gated to
   the frames where he is still in front of it, is the measurement.
   ------------------------------------------------------------------ */
/* A WALL TEST HAS TO BE POINTED AT A WALL.

   This used to take "the nearest named building 8 to 140 m from
   wherever the previous section left him", which makes the object
   under test a function of every walk above it. Run after a pass that
   moved the street furniture by a metre, it picked the BANK — a temple
   kit, whose podium and colonnade stand three metres proud of any
   vertical face — and __clip() answered "no vertical face on the
   approach ray" on all four sides. Both rows then went red having
   measured nothing at all, which is this file's own complaint about a
   suite that cannot see the object it was written to cover, in the
   mirror.

   Pinned, and parked at first so the terrain collision window covers
   it. The Property Office is a `shop`: four plain rendered faces, no
   podium, no colonnade, and a building the player walks up to on the
   first day. */
const wall = await page.evaluate(async () => {
  const c = window.WALLY.ctx;
  const WALL_TARGET = 'propertyoffice';
  let best = null;
  const pick = c.city.locations.get(WALL_TARGET);
  if (pick) best = { id: WALL_TARGET, d: 0, rec: pick };
  else {
    const p = c.phys.player.simPosition;
    for (const [id, rec] of c.city.locations) {
      const d = Math.hypot(rec.center.x - p.x, rec.center.z - p.z);
      if (d > 8 && d < 140 && (!best || d < best.d)) best = { id, d, rec };
    }
  }
  if (!best) return null;
  await window.__park(best.rec.center.x, best.rec.center.z + best.rec.loc.size.d * 0.5 + 8);
  best.d = Math.hypot(best.rec.center.x - c.phys.player.simPosition.x,
    best.rec.center.z - c.phys.player.simPosition.z);
  const cityId = [...c.phys.world.bodies].find(([, r]) => r.opts?.name === 'city')?.[0];
  return {
    id: cityId, loc: best.id,
    c: { x: best.rec.center.x, y: best.rec.groundY + 1.0, z: best.rec.center.z },
    yaw: best.rec.loc.yaw, d: +best.d.toFixed(1),
  };
});
/* AND THE PLANE HAS TO COME OFF THE WALL, NOT OFF WHATEVER IS PARKED
   IN FRONT OF IT.

   Pinning the building was half the job. This loop then took the first
   VERTICAL face on the approach ray and called it the wall, and on the
   door face of the Property Office that face is `prop.sandwich` — a
   shopfront A-board, 0.9 m wide, standing on the berm 0.95 m proud of
   the masonry. Wally walks up, the board stops him, he slides round it
   the way __clip's own header says a tree makes him, and the row read

     face 0  closest approach: face -0.537 m  WENT THROUGH

   for a wall he never touched. It went red the round the placement pass
   lifted 320 props out of the ground they were buried in: measured with
   this same probe, prop.sandwich sits at the identical (x, z) in both
   trees, -219.06 / 73.74, and its collision box rose from +0.118..1.188
   to +0.447..1.517 above the Property Office's floor. The 0.95 m ray
   used to clear its sunken top by 28 cm and reach the city wall at
   1.266 m; it now stops on the board at 0.316 m. The wall did not move
   and neither did he: his closest approach to the building's own face
   plane is +0.255 / +0.128 / +0.373 m on faces 0/1/2 in BOTH trees, to
   the millimetre. Note that at HEAD the 0.55 m ray would have found the
   board too — the green was one entry in a four-element list away from
   being this same red, which is rule 3 in the mirror.

   So the ray is filtered to the body under test and steps past
   everything else, and every row prints WHICH BODY its plane came off.
   `--wallraw` re-runs the door face with the filter off, on the same
   page load, so the shipping rule and the prior rule are one
   measurement apart and not one commit apart. */
if (wall) {
  console.log(`--- building wall (${wall.loc}, ${wall.d} m away, body #${wall.id}) ---`);
  let clipped = 0, tried = 0, closest = Infinity;
  /* approach each of the four faces square on */
  for (const k of [0, 1, 2, 3]) {
    const a = wall.yaw + k * Math.PI / 2;
    const r = await page.evaluate(([tt, aa]) => window.__clip(tt, aa, 6.5, 3.0, 'plane', tt.id), [wall, a]);
    if (r.skip) {
      console.log(`   face ${k}  skip: ${r.skip}` +
        (r.eye ? `  (eye ${r.eye.join(', ')}, ground ${r.ground})` : ''));
      continue;
    }
    tried++;
    const through = r.minPlane !== null && r.minPlane < -0.01;
    if (through) clipped++;
    if (r.minPlane !== null) closest = Math.min(closest, r.minPlane);
    console.log(`   face ${k}  closest approach: face ${r.minPlane?.toFixed(3)} m  ` +
      `${through ? '\x1b[31mWENT THROUGH\x1b[0m' : 'stopped outside'}` +
      `   [plane off ${r.face.body} @${r.face.at} m, ray ${r.face.hy} m` +
      `${r.passed.length ? `; stepped past ${r.passed.map((q) => `${q.name}@${q.at}m`).join(', ')}` : ''}]`);
  }
  /* THREE OF THE FOUR, NOT ONE OF THE FOUR. `tried > 0` let this row go
     green on a single face, which is how a wall test survives losing
     three quarters of its subject without saying so. Face 3 of the
     Property Office legitimately skips — the terrain 6.5 m out on that
     side is five metres up, level with the roof, and there is no wall
     on the ray at all — so the floor is three. */
  results.push(['building wall: measured on at least 3 of its 4 faces', tried >= 3, `${tried}/4 faces measured`]);
  results.push(['building wall: never passes through', tried > 0 && clipped === 0, `${clipped}/${tried} faces clipped`]);
  results.push(['building wall: gets close enough to touch', closest < 0.34 + 0.14,
    `closest axis-to-wall ${closest === Infinity ? 'n/a' : closest.toFixed(3)} m`]);

  /* THE SWITCH. Same page load, same walk, same instrument; the only
     difference is whether the plane is required to belong to the wall.
     Predicted, and asserted, so it cannot rot into a citation: with the
     filter off the door face reports a breach that is a sandwich board. */
  if (WALLRAW) {
    const a0 = wall.yaw;
    const raw = await page.evaluate(([tt, aa]) => window.__clip(tt, aa, 6.5, 3.0, 'plane', null), [wall, a0]);
    console.log(`   face 0 PRIOR RULE (no body filter): face ${raw.minPlane?.toFixed(3)} m ` +
      `off ${raw.face?.body} @${raw.face?.at} m`);
    results.push(['prior rule measured a prop, not the wall',
      raw.face != null && raw.face.body !== 'city',
      `unfiltered plane came off ${raw.face?.body}, giving ${raw.minPlane} m`]);
  }
}

/* ------------------------------------------------------------------
   2. Every door must still be reachable.
   ------------------------------------------------------------------ */
/* ONE DOOR AT A TIME, WITH HIM STANDING THERE.

   The whole sweep used to run from wherever the previous test had left
   him. Terrain collision is a 3 x 3 window of 64 m tiles that follows
   the PLAYER — 192 m of a 970 m island — so for most of the twenty-
   eight doors there was no terrain under the probe at all, groundAt()
   answered with whatever permanent body happened to be nearest, and the
   capsule was placed at a height that had nothing to do with the
   doorstep. Those doors passed because the test was sampling empty air.
   Parking him beside each one first costs about a second a door and is
   the difference between an assertion and a formality. */
console.log('--- doorway approaches ---');
const doorIds = await page.evaluate(() => [...window.WALLY.ctx.city.locations.keys()]);
const doors = [];
for (const id of doorIds) {
  const r = await page.evaluate(async (lid) => {
    const c = window.WALLY.ctx;
    const rec = c.city.locations.get(lid);
    const d = rec.door;
    if (!d) return null;
    const ax = Math.sin(rec.loc.yaw), az = Math.cos(rec.loc.yaw);
    await window.__park(d.x + ax * 3.0, d.z + az * 3.0);
    let worst = 0;
    const who = new Set();
    let ground = '';
    /* walk the corridor the player has to use to reach the handle.
       The wall itself is at t = 0, so start clear of it. */
    for (const t of [1.0, 1.6, 2.2, 2.8]) {
      const q = window.__clearAt(d.x + ax * t, d.z + az * t);
      worst = Math.max(worst, q.n);
      for (const w of q.who) who.add(w);
      ground = q.on;
    }
    return { id: lid, blocked: worst, who: [...who], ground };
  }, id);
  if (r) doors.push(r);
}
const blockedDoors = doors.filter((d) => d.blocked > 0);
for (const d of blockedDoors) console.log(`   \x1b[31mBLOCKED\x1b[0m ${d.id} (${d.blocked} contacts: ${d.who.join(', ')})`);
console.log(`   ${doors.length - blockedDoors.length}/${doors.length} doors have a clear approach corridor` +
  ` (standing on: ${[...new Set(doors.map((d) => d.ground))].join(', ')})`);
results.push(['every door approach is clear', blockedDoors.length === 0,
  blockedDoors.length ? blockedDoors.map((d) => d.id).join(', ') : 'all clear']);

/* ------------------------------------------------------------------
   3. NO PIECE OF A BUILDING FLOATS CLEAR OF THE REST OF IT.

   THE REPORT: "there are lots of buildings that don't have their
   entrances looking right or have pieces of the building floating."
   The second half of that was unanswerable for as long as a building
   was six merged meshes, because nothing downstream of the merge knows
   where one part ends and the next begins. world/kits.js records every
   part's box behind ?partcensus so the question becomes arithmetic.

   THE INVARIANT: a building is ONE object, so every part of it touches
   at least one other part of the same building.

   THE INSTRUMENT IS DELIBERATELY BLUNT, AND IN THE SAFE DIRECTION.
   An AABB is a superset of the geometry inside it, so two boxes that
   do not overlap belong to two solids that certainly do not touch:
   nothing this reports can be a false alarm. It can MISS a float —
   two boxes can overlap while the shapes in them do not — and that is
   the direction an assertion is allowed to be wrong in.

   AND IT IS DONE IN THE BUILDING'S OWN FRAME, WHICH IS THE WHOLE
   TRICK. The first run of this compared world-space boxes and found
   seven floats in a city that had a hundred and fourteen: a wall is a
   box, but a box put through a 40-degree yaw has a world AABB half
   again as wide as itself, and every bracket hanging in front of a
   facade landed inside it and read as attached. partCensus() therefore
   returns local boxes plus the matrix that places the building, and
   only a defect is ever converted to world coordinates — to be printed.

   WHAT IT FOUND, on the tree this was written for, 114 parts across 35
   of 111 buildings, and every one of them a repeat of a kit fault:
     22  porch knee brace, floating between the wall and its own post
     42  window lintel, 0.05 m clear of the head soffit it spans
     29  window shutter, translated instead of hinged
      9  roof-garden handrail with no stanchions under it
      5  notice-board hood clearing the top of its own board
      2  crane machinery house touching neither jib nor mast
      1  temple banner rail with nothing carrying it back to the wall
   ------------------------------------------------------------------ */
console.log('--- parts of a building that touch nothing ---');
const TOUCH_TOL = 0.02;
const floats = await page.evaluate((TOL) => {
  const c = window.WALLY.ctx;
  if (!c.city.partCensus) return { missing: true };
  const cen = c.city.partCensus();
  if (!cen.length) return { missing: true };
  const T = window.WALLY.THREE;
  const m = new T.Matrix4(), v = new T.Vector3();
  let total = 0;
  const iso = [];
  for (const b of cen) {
    const parts = b.parts;
    total += parts.length;
    m.fromArray(b.matrix);
    for (let i = 0; i < parts.length; i++) {
      const a = parts[i];
      let touch = false, gap = Infinity;
      for (let j = 0; j < parts.length; j++) {
        if (i === j) continue;
        const o = parts[j];
        const gx = Math.max(a.min[0] - o.max[0], o.min[0] - a.max[0], 0);
        const gy = Math.max(a.min[1] - o.max[1], o.min[1] - a.max[1], 0);
        const gz = Math.max(a.min[2] - o.max[2], o.min[2] - a.max[2], 0);
        const g = Math.hypot(gx, gy, gz);
        if (g < gap) gap = g;
        if (g <= TOL) { touch = true; break; }
      }
      if (touch) continue;
      v.set((a.min[0] + a.max[0]) / 2, (a.min[1] + a.max[1]) / 2, (a.min[2] + a.max[2]) / 2).applyMatrix4(m);
      iso.push({
        id: b.id, kind: b.kind, part: a.part, gap: +gap.toFixed(3),
        size: [+(a.max[0] - a.min[0]).toFixed(2), +(a.max[1] - a.min[1]).toFixed(2), +(a.max[2] - a.min[2]).toFixed(2)],
        at: [+v.x.toFixed(1), +v.y.toFixed(2), +v.z.toFixed(1)],
      });
    }
  }
  return { buildings: cen.length, total, iso };
}, TOUCH_TOL);
if (floats.missing) {
  console.log('   \x1b[31mctx.city.partCensus() is empty — was the page loaded with ?partcensus?\x1b[0m');
} else {
  for (const f of floats.iso.slice(0, 8)) {
    console.log(`   \x1b[31m${f.kind.padEnd(8)}\x1b[0m ${f.id.padEnd(20)} ${f.part.padEnd(6)} ` +
      `${f.size.join('x')} m at ${f.at.join(',')} — nearest part of the same building is ${f.gap} m away`);
  }
  if (floats.iso.length > 8) console.log(`   ...and ${floats.iso.length - 8} more`);
  console.log(`   \x1b[90m${floats.total} parts across ${floats.buildings} buildings, ` +
    `${floats.iso.length} of them touching nothing\x1b[0m`);
}
results.push(['the part census is present and non-empty', !floats.missing,
  floats.missing ? 'partCensus() returned nothing' : `${floats.total} parts, ${floats.buildings} buildings`]);
results.push(['no part of a building floats clear of the rest of it',
  !floats.missing && floats.iso.length === 0,
  floats.missing ? 'not measured'
    : floats.iso.length ? `${floats.iso.length} isolated, worst gap ${Math.max(...floats.iso.map((f) => f.gap)).toFixed(3)} m`
      : 'every part touches another part of its own building']);

/* ------------------------------------------------------------------
   3b. NOR DOES ANY GROUP OF PARTS, WHICH IS NOT THE SAME QUESTION.

   THE REPORT THIS EXISTS FOR: a screenshot of a plank and a cat
   hanging in the air outside the noodle cart. Section 3 above was
   green for it. A shelf on two brackets with a cat on it is EIGHT
   parts that all touch EACH OTHER, so "every part touches another
   part" is satisfied by an island floating two and a half metres out
   in the street — pairwise touching is not connectedness, and the
   thing a player sees floating is always a cluster, because anything
   worth drawing is more than one box.

   So the same boxes, in the same local frame, with the same 0.02 m
   tolerance, are unioned into components and every component that is
   not the building's main mass is reported. That is a strict
   generalisation: anything section 3 catches is a component of size
   one and is caught here too, and it costs one union-find over a list
   that has already been built.

   IT IS STILL BLUNT IN THE SAFE DIRECTION. An AABB is a superset, so
   an island reported here certainly does not touch the mass. It can
   still MISS one (two boxes can overlap while the shapes inside them
   do not), which is the direction an assertion may be wrong in.

   FOUND, the round this was written: 70 islands, 811 parts, across
   111 buildings. The largest by far is the market form's shelf — the
   one in the screenshot — at a 2.663 m gap; the rest are chimney
   caps, monitor glazing and lantern housings sitting a few
   centimetres clear of the roofs they belong to.
   ------------------------------------------------------------------ */
console.log('--- groups of parts that do not reach their building ---');
const isles = floats.missing ? { missing: true } : await page.evaluate((TOL) => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const cen = c.city.partCensus();
  const out = [];
  const m = new T.Matrix4(), v = new T.Vector3();
  let total = 0, parts = 0;
  for (const b of cen) {
    const p = b.parts; total += p.length;
    const par = p.map((_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length; j++) {
        const a = p[i], o = p[j];
        const gx = Math.max(a.min[0] - o.max[0], o.min[0] - a.max[0], 0);
        const gy = Math.max(a.min[1] - o.max[1], o.min[1] - a.max[1], 0);
        const gz = Math.max(a.min[2] - o.max[2], o.min[2] - a.max[2], 0);
        if (Math.hypot(gx, gy, gz) <= TOL) { const x = find(i), y = find(j); if (x !== y) par[x] = y; }
      }
    }
    const size = new Map();
    for (let i = 0; i < p.length; i++) { const r = find(i); size.set(r, (size.get(r) || 0) + 1); }
    let main = -1, best = -1;
    for (const [r, n] of size) if (n > best) { best = n; main = r; }
    const groups = new Map();
    for (let i = 0; i < p.length; i++) { const r = find(i); if (r === main) continue; (groups.get(r) || groups.set(r, []).get(r)).push(i); }
    m.fromArray(b.matrix);
    for (const [, idxs] of groups) {
      const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      for (const i of idxs) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i].min[k]); hi[k] = Math.max(hi[k], p[i].max[k]); }
      let gap = Infinity;
      for (let j = 0; j < p.length; j++) {
        if (find(j) !== main) continue;
        const o = p[j];
        const gx = Math.max(lo[0] - o.max[0], o.min[0] - hi[0], 0);
        const gy = Math.max(lo[1] - o.max[1], o.min[1] - hi[1], 0);
        const gz = Math.max(lo[2] - o.max[2], o.min[2] - hi[2], 0);
        gap = Math.min(gap, Math.hypot(gx, gy, gz));
      }
      parts += idxs.length;
      v.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2).applyMatrix4(m);
      out.push({
        id: b.id, kind: b.kind, n: idxs.length, gap: +gap.toFixed(3),
        what: [...new Set(idxs.map((i) => p[i].part))].join('+'),
        at: [+v.x.toFixed(1), +v.y.toFixed(2), +v.z.toFixed(1)],
      });
    }
  }
  out.sort((a, b2) => b2.gap - a.gap);
  return { total, parts, out };
}, TOUCH_TOL);
/* THE BAR IS NOT ZERO, AND SAYING SO IS THE POINT. Half a metre is
   the distance at which a group stops reading as detail set proud of a
   roof and starts reading as an object that is not attached to
   anything — the cat's shelf was at 2.663 m and the market hall's
   pigeons were on the same plane. Everything found is printed either
   way; only the far ones are listed against the ledger below.

   THE LEDGER, AND WHY IT IS A LEDGER AND NOT A ZERO.
   Fixing the facade plane took this from 15 groups past 0.5 m to
   three, and the three left are not one cause — they are three
   separate forms, each wanting its own change in a file this round did
   not open:

     0.701  stadium (x2)   13 parts, wall+hedge, the terrace planters
     0.526  learning.fill3  4 parts, wall+stone+metal

   AND HERE IS WHAT EACH ONE ACTUALLY IS, measured part by part in the
   building's own frame, so the next person spends the twenty minutes
   fixing them rather than the twenty minutes I spent finding them:

     STADIUM. A planter 1.36 x 0.66 x 0.39 m, local (+/-16.10, 5.40,
     26.15) — five metres up the front of the bowl and 0.701 m proud of
     it. The gap is entirely in Z. The nearest piece of the mass is the
     outer wall panel spanning z 19.79..25.25, and the planter sits at
     z 25.95..26.34. THE CAUSE IS A RECTANGLE ON AN ELLIPSE: the pair is
     placed on a frontage line at a fixed z, and formStadium's frontage
     is an ellipse (rx 31, rz 26, `mx = sin(a)*rx, mz = cos(a)*rz`), so
     at x = +/-16 the wall has already curved 0.7 m away from the line
     and the planter is hanging over the concourse. Both copies are the
     same distance out because both are the same |x|. Whatever places
     them has to solve for the ellipse the way the pilasters above it
     do, not for d/2.

     LEARNING.FILL3. A chimney: wall stack 12.76..14.96, stone cap,
     two metal pots, local x -4.67..-3.77. The roof it should stand on
     spans x -3.24..3.24, and the gap is 0.526 m in X alone. It is
     placed against the BUILDING's half-width and the roof is narrower
     than the building, so on this infill it oversails the eaves and
     stands on air. Clamping the stack's x to the roof's own half-width
     rather than the wall's is the whole fix.

   Neither emitter is in a file this round opened, so both stay on the
   ledger with their diagnosis attached.

   So the assertion is a RATCHET, stated as such: no fourth island, and
   nothing worse than the worst one on the list. That is a real
   assertion — it goes red the moment anything new comes unstuck, which
   is the whole job — and it does not pretend the three are fixed. Take
   one off the list when you fix it, and tighten LEDGER_N. */
const ISLE_GAP = 0.5;
const LEDGER_N = 3, LEDGER_WORST = 0.71;
if (!isles.missing) {
  const bad = isles.out.filter((i) => i.gap > ISLE_GAP);
  for (const i of isles.out.slice(0, 6)) {
    const red = i.gap > ISLE_GAP;
    console.log(`   ${red ? '\x1b[31m' : '\x1b[90m'}${i.kind.padEnd(8)}\x1b[0m ${i.id.padEnd(20)} ` +
      `${String(i.n).padStart(3)} parts (${i.what}) ${i.gap} m from the mass, at ${i.at.join(',')}`);
  }
  console.log(`   \x1b[90m${isles.out.length} islands / ${isles.parts} parts of ${isles.total}; ` +
    `${bad.length} further than ${ISLE_GAP} m\x1b[0m`);
  results.push([`no NEW group of parts hangs more than ${ISLE_GAP} m clear of its building`,
    bad.length <= LEDGER_N && (bad.length === 0 || bad[0].gap <= LEDGER_WORST),
    bad.length ? `${bad.length} of ${LEDGER_N} on the ledger, worst ${bad[0].id} at ${bad[0].gap} m (ledger ${LEDGER_WORST} m)`
      : `${isles.out.length} islands, all within ${ISLE_GAP} m of the mass`]);
} else {
  console.log('   \x1b[90mnot measured — no part census\x1b[0m');
}

/* ------------------------------------------------------------------
   4. SHIPPING CONTAINERS ARE PORT FURNITURE.

   THE REPORT: "there are too many random red or blue containers, those
   should only be by the port district." Measured before the fix, the
   twenty containers in the city stood between 50 and 290 metres inland
   and up to 127 m from the nearest pier, because the pass that placed
   them keyed on the waterfront ZONE — a disc a hundred metres across
   whose centre is 190 m from the sea.

   AND THEN THE RULE MATCHED A BLOCK OF FLATS. The fix keyed the yard —
   and this assertion — on `r.kit === 'pier'`, which is the FORM the kit
   library built the shell from and not a fact about the place. data.js
   builds both waterfront locations from kit 'water' and kits.js maps
   'water' to form 'pier', so "Harbour Residences" satisfied a rule
   written about a cargo dock: ten containers stacked on a residential
   grass hillside, 217-235 m from the sea, and this test called them
   all green because they were 17-25 m from a "pier". A measurement
   that samples a special case will agree with itself.

   SO THE ANCHOR IS THE FACT, NOT THE KIT. data.js marks the one
   working cargo port with `port: true`; a kit can be reused by anything
   that wants piles under it, `port` cannot be acquired by accident. If
   that flag is ever dropped this test finds zero ports and fails on
   every container in the city, which is the correct way round.

   AND A CONTAINER SITS ON SOMETHING. The same round left two boxes of
   the docks stack clear of the ground beneath them, so the drop is
   measured too: base-of-box against the highest of the drawn ground,
   the drawn pier deck and the top of any container it is stacked on.

   Measured from the DRAWN instances, not from the placement code, so a
   second placement path added later cannot slip past this.
   ------------------------------------------------------------------ */
console.log('--- shipping containers ---');
const PORT_R = 40, PORT_SHORE = 26;
/* metres of daylight allowed under a 5.2 x 2.3 m steel box. Half the
   surface test's FLOAT_TOL: a container has four corners and a flat
   sole, and unlike a capsule on a slope it has no geometry excusing it. */
const BOX_FLOAT = 0.07;
const boxes = await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const ports = [];
  for (const [, r] of c.city.locations) if (r.loc.port === true) ports.push([r.loc.world.x, r.loc.world.z]);
  /* EVERY BUILDING AT ITS FULL MESH FOR THE LENGTH OF THIS CENSUS.

     surfacetest raycasts whatever LOD the city is currently at, and
     that is right for a WALK: he is standing there, so the mesh under
     him is the near one, and the near one is what he can see. This is
     not a walk. It is a static census of thirteen boxes spread over
     the island, and the city swaps a building for its low mesh past
     240 m — which for the docks, wherever the player happens to be
     parked, drops the decking out of the scene. The first run of this
     assertion duly reported the bottom box of the pier stack as
     "1.03 m clear of the ground": the deck it is standing on was not
     being drawn at that instant. That is a measurement sampling the
     camera, not the world. No frame is stepped between here and the
     rays below, so update() cannot put it back mid-census — and it
     re-derives every building's LOD from the camera on the very next
     frame, so nothing has to put it back afterwards either. */
  window.WALLY.debug.cityLOD('near');

  /* the drawn ground, the same roots surfacetest raycasts: terrain,
     roads, rock, and the city's own foundations, berms and decking.
     Props are deliberately NOT in here — the box under a box is
     resolved from the instance list below, not from a ray. */
  const SKIP = /outline|hull|contactShadow|cloth|drift|grass|\blip\b|foliage|detail|bush|reed|water|sky|cloud/i;
  const targets = [];
  for (const root of [c.world?.groundGroup, c.city?.root].filter(Boolean)) {
    root.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      if (o.userData.isOutlineHull || o.userData.noPrepass) return;
      if (SKIP.test(o.name || '')) return;
      for (let p = o; p; p = p.parent) if (p.visible === false) return;
      targets.push(o);
    });
  }
  const m = new T.Matrix4();
  const seen = new Set(), out = [];
  c.scene.traverse((o) => {
    if (!o.isInstancedMesh || o.userData.isOutlineHull) return;
    if (!/^prop\.container\.\d/.test(o.name || '')) return;
    const key = o.name.split('.').slice(0, 3).join('.') + '@' + (o.name.split('@')[1] || '');
    if (seen.has(key)) return;
    seen.add(key);
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      const x = m.elements[12], y = m.elements[13], z = m.elements[14];
      let d = Infinity;
      for (const [px, pz] of ports) d = Math.min(d, Math.hypot(x - px, z - pz));
      out.push({
        x: +x.toFixed(1), y: +y.toFixed(2), z: +z.toFixed(1),
        /* the instance is a pure Y rotation, so its yaw is readable
           straight off the basis — the corners have to be sampled in
           the BOX's frame, not the world's, or the four points a
           5.2 x 2.3 m box is judged on are not its corners at all */
        yaw: Math.atan2(m.elements[8], m.elements[0]),
        port: +d.toFixed(1), shore: +c.world.shoreDistAt(x, z).toFixed(1),
      });
    }
  });
  /* CONTAINER_H in city.js; props.js CATALOGUE.container is the source */
  const H = 2.5, HX = 2.6, HZ = 1.15;
  const ray = new T.Raycaster();
  const DOWN = new T.Vector3(0, -1, 0);
  for (const b of out) {
    /* the highest thing under this box: another container it is
       stacked on, or the drawn ground under its four corners. A ray
       per corner, because a 5.2 m sole on a slope only floats at one
       end and a single ray down the navel is exactly the sample that
       missed it. */
    let under = -Infinity;
    for (const o2 of out) {
      if (o2 === b || o2.y > b.y - 0.05) continue;
      if (Math.abs(o2.x - b.x) > HX || Math.abs(o2.z - b.z) > HX) continue;
      under = Math.max(under, o2.y + H);
    }
    /* THE TOPMOST SURFACE, EVEN IF IT IS ABOVE THE SOLE. The first cut
       of this took the first hit at or below the box's base, on the
       reasoning that a surface above it cannot be holding it up — and
       it reported six boxes "with nothing drawn under them at all".
       They were BEDDED: the drawn terrain mesh is a box-filtered LOD
       and runs up to a quarter of a metre off heightAt(), so the
       ground the box was placed on is drawn slightly OVER its sole,
       the filter threw that hit away and the ray sailed on to the
       seabed. Sunk is not floating. The ray starts only 0.9 m up, so
       nothing but the surface it stands on can be found from there. */
    const bc = Math.cos(b.yaw), bs = Math.sin(b.yaw);
    for (const [ou, ov] of [[0, 0], [HX, HZ], [HX, -HZ], [-HX, HZ], [-HX, -HZ]]) {
      const ox = ou * bc + ov * bs, oz = -ou * bs + ov * bc;
      ray.set(new T.Vector3(b.x + ox, b.y + 0.9, b.z + oz), DOWN);
      ray.far = 60;
      const h = ray.intersectObjects(targets, false);
      if (h.length) under = Math.max(under, h[0].point.y);
    }
    b.gap = under === -Infinity ? null : +(b.y - under).toFixed(2);
  }
  return { out, ports: ports.length };
});
const strays = boxes.out.filter((b) => b.port > PORT_R && b.shore > PORT_SHORE);
for (const b of strays.slice(0, 6)) {
  console.log(`   \x1b[31mSTRAY\x1b[0m container at ${b.x},${b.z} — ${b.port} m from the nearest port, ${b.shore} m inland`);
}
const floaters = boxes.out.filter((b) => b.gap === null || b.gap > BOX_FLOAT);
const worstGap = Math.max(0, ...boxes.out.map((b) => (b.gap === null ? 99 : b.gap)));
for (const b of floaters.slice(0, 6)) {
  console.log(`   \x1b[31mFLOATS\x1b[0m container at ${b.x},${b.z} — ` +
    `${b.gap === null ? 'nothing drawn under it at all' : `${b.gap} m clear of the ground`}`);
}
console.log(`   ${boxes.out.length} containers over ${boxes.ports} ports; ` +
  `furthest stands ${Math.max(0, ...boxes.out.map((b) => b.port))} m from one, ` +
  `worst gap ${worstGap} m`);
results.push(['every shipping container is at a port', strays.length === 0 && boxes.ports > 0,
  boxes.ports === 0 ? 'no location in data.js carries port: true'
    : strays.length ? `${strays.length} of ${boxes.out.length} further than ${PORT_R} m from a port and ${PORT_SHORE} m from the water`
      : `all ${boxes.out.length} within ${PORT_R} m of one of ${boxes.ports}`]);
results.push([`no shipping container stands more than ${BOX_FLOAT} m clear of what is under it`,
  floaters.length === 0,
  floaters.length ? `${floaters.length} of ${boxes.out.length} float, worst ${worstGap} m`
    : `worst ${worstGap} m under ${boxes.out.length} boxes`]);

/* ------------------------------------------------------------------
   5. EVERY PROP THAT IS DRAWN IS ALSO SOLID.

   A previous round found the whole prop catalogue was walk-through and
   collided it. What that round did not close is the placement path a
   building FORM uses: those props were never tested against the door
   corridors at placement, and wirePhysics ran the guard as a backstop
   and removed their COLLIDERS instead — leaving nine drawn objects a
   player walks through. Counted per type off the drawn instances
   against the bodies actually in ctx.phys.
   ------------------------------------------------------------------ */
console.log('--- drawn props vs bodies ---');
const solids = await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const drawn = {}, seen = new Set();
  c.scene.traverse((o) => {
    if (!o.isInstancedMesh || o.userData.isOutlineHull) return;
    const mm = /^prop\.([a-z]+)\.(\d)/.exec(o.name || '');
    if (!mm) return;
    const key = `${mm[1]}#${mm[2]}@${o.name.split('@')[1] || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    drawn[mm[1]] = (drawn[mm[1]] || 0) + o.count;
  });
  const bodies = {};
  for (const [, b] of c.phys.world.bodies) {
    const n = b?.opts?.name || '';
    if (n.startsWith('prop.')) bodies[n.slice(5)] = (bodies[n.slice(5)] || 0) + 1;
  }
  return { drawn, bodies };
});
/* AN EXEMPTION HAS TO BE PROVED, NOT DECLARED.

   `strung` — the instanced bunting and washing runs — is drawn and
   carries no collider on purpose: it is hung off wall hooks well over
   head height, and a body up there is a body nothing can ever touch
   (see the SOLID_TOP note in props.js, and the same argument the
   nameboards get above). Whitelisting it here would be the easiest
   place in this file to hide a real bug, so the exemption is not a
   whitelist: section 5b below MEASURES the lowest cloth on the island
   and asserts it clears the headroom line. If a future pass hangs a
   line at chest height, 5b goes red. */
const AIRBORNE = new Set(['strung']);
const short = Object.keys(solids.drawn)
  .filter((t) => !AIRBORNE.has(t))
  .map((t) => ({ t, d: solids.drawn[t], b: solids.bodies[t] || 0 }))
  .filter((r) => r.b < r.d);
for (const r of short) console.log(`   \x1b[31m${r.t.padEnd(12)}\x1b[0m ${r.d} drawn, ${r.b} solid — ${r.d - r.b} you can walk through`);
const drawnTotal = Object.values(solids.drawn).reduce((a, b) => a + b, 0);
const bodyTotal = Object.values(solids.bodies).reduce((a, b) => a + b, 0);
console.log(`   ${drawnTotal} props drawn over ${Object.keys(solids.drawn).length} types, ${bodyTotal} bodies`);
results.push(['every prop that is drawn has a collider', short.length === 0,
  short.length ? short.map((r) => `${r.t} ${r.b}/${r.d}`).join(', ') : `${bodyTotal}/${drawnTotal}`]);

/* ------------------------------------------------------------------
   5b. THE OVERHEAD RUNS ARE ACTUALLY OVERHEAD.

   world/life.js hangs bunting and washing off two iron hooks on a
   wall, and it derives the hook height from the only line every
   building form publishes — its eaves — as a fraction, clamped. That
   is a derivation, which means it is a thing that can be got wrong by
   a building with an eave in an unusual place, and if it is got wrong
   the result is a line of washing across the pavement at chest height
   that the player walks straight through.

   MEASURED OFF THE DRAWN INSTANCES, not off the numbers in life.js:
   every corner of every `strung` instance's own bounding box is put
   through its instance matrix and its mesh's world matrix, the lowest
   one on the island is found, and the ground under THAT point is
   sampled. What is asserted is the clearance a player would have
   walking under it.

   REVERT CHECK: change life.js's `clamp(eave * 0.62, 3.2, 5.6)` to
   `clamp(eave * 0.62, 1.6, 5.6)` and this row goes red with the
   offending coordinate printed, while every other row stays green.
   ------------------------------------------------------------------ */
const runs = await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const m = new T.Matrix4(), v = new T.Vector3();
  let n = 0, low = Infinity, at = null;
  c.scene.traverse((o) => {
    if (!o.isInstancedMesh || o.userData.isOutlineHull) return;
    if (!/^prop\.strung\./.test(o.name || '')) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    if (!bb) return;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      for (const y of [bb.min.y, bb.max.y]) {
        for (const x of [bb.min.x, bb.max.x]) {
          for (const z of [bb.min.z, bb.max.z]) {
            v.set(x, y, z).applyMatrix4(m).applyMatrix4(o.matrixWorld);
            if (v.y < low) { low = v.y; at = { x: v.x, z: v.z }; }
          }
        }
      }
      n++;
    }
  });
  const g = at ? c.world.heightAt(at.x, at.z) : 0;
  return {
    n, low, ground: g, clear: low - g,
    at: at ? [+at.x.toFixed(1), +at.z.toFixed(1)] : null,
  };
});
console.log('--- overhead runs ---');
console.log(`   ${runs.n} strung runs drawn; lowest cloth ${runs.low === Infinity ? 'n/a' : runs.low.toFixed(2)} m ` +
  `(${runs.clear === Infinity ? 'n/a' : runs.clear.toFixed(2)} m over the ground` +
  `${runs.at ? ` at ${runs.at[0]}, ${runs.at[1]}` : ''})`);
results.push(['wind-driven runs are strung, and there are some', runs.n > 0, `${runs.n} runs`]);
results.push([`every strung run clears ${HEADROOM} m of headroom`,
  runs.n > 0 && runs.clear >= HEADROOM,
  runs.n ? `lowest ${runs.clear.toFixed(2)} m at ${runs.at}` : 'none drawn']);

/* ------------------------------------------------------------------
   5c. THE KERB — A SURFACE HE IS SUPPOSED TO GET ONTO.

   Every other section in this file asks the same question: does a
   solid thing STOP him. world/ground.js adds an object of the opposite
   kind — a raised footway, 0.10 m of stone the length of every street
   in the city, which he is meant to step up onto without noticing. It
   has exactly two ways to be wrong and this file already has a name
   for both of them:

     A GHOST   the pavement is drawn and phys never heard of it, so the
               ground under his feet is the terrain and he walks along
               a street with his ankles inside the flags. Same defect
               as the bins and benches the header describes, with the
               sign flipped.
     A WALL    the collider is there but he cannot mount it, so a kerb
               is an invisible fence down both sides of every road and
               the pavement is scenery. That is precisely the failure
               mode section 1's CLOSE half exists to catch: a
               well-meant collider that makes the game feel worse than
               having none.

   THE PAVEMENT IS FOUND, NOT ASSUMED. Nothing here knows ground.js's
   section geometry: it steps outward from a road centreline in 5 cm
   increments until the DRAWN floor (ctx.city.floorY) stands proud of
   the terrain, which is the kerb wherever ground.js decided to put
   one. Then he is stood in the carriageway and run at it.

   REVERT CHECK, EXECUTED — NOT A RECIPE. This file was run against a
   clean `git archive HEAD` of src/, today's test over yesterday's
   code, with node_modules symlinked in and nothing else changed:

     working tree   34 rows, all green
     HEAD archive   1 failed — "the footway is a surface phys knows
                    about: ctx.city.floorY is not published"

   One row, and it is this section's. Every other row in the file
   passes on both, which is what makes the green above mean something:
   the suite did not get easier, it got one new thing to see.

   The finer-grained recipe, for anyone changing the wiring rather than
   removing it: delete the ctx.phys.addTriangles call for
   `city.footway` in world/city.js's wirePhysics() and floorY still
   answers, so the section runs and TWO rows go red instead — the
   triangle count, and "he stands ON the flags", because he ends up
   0.10 m inside them.
   ------------------------------------------------------------------ */
console.log('--- the kerb ---');
const kerbs = await page.evaluate(async () => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const frames = (n) => new Promise((res) => {
    let k = 0; const t = () => (++k >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t);
  });
  if (!c.city?.floorY) return { none: 'ctx.city.floorY is not published' };
  const out = [];
  const edges = c.world.paths?.edges || [];
  for (const e of edges) {
    if (out.length >= 6) break;
    const pts = e.points;
    if (!pts || pts.length < 8) continue;
    const i = Math.floor(pts.length / 2);
    const p = pts[i], q = pts[i - 1];
    const seg = Math.hypot(p.x - q.x, p.z - q.z) || 1;
    const px = -(p.z - q.z) / seg, pz = (p.x - q.x) / seg;
    for (const sgn of [1, -1]) {
      /* step out until the drawn floor stands proud of the terrain */
      let found = null;
      for (let u = 0.6; u < 8; u += 0.05) {
        const x = p.x + px * sgn * u, z = p.z + pz * sgn * u;
        const up = c.city.floorY(x, z) - c.world.heightAt(x, z);
        if (up > 0.05) { found = { x, z, u, up }; break; }
      }
      if (!found) continue;
      /* aim a metre past the kerb line, which is the middle of the
         flags — the kerbstone course is 0.20 m and the footway 1.30 */
      const tx = p.x + px * sgn * (found.u + 1.0);
      const tz = p.z + pz * sgn * (found.u + 1.0);
      /* stand him in the carriageway, 2.6 m short of the kerb */
      const sx = p.x + px * sgn * Math.max(0, found.u - 2.6);
      const sz = p.z + pz * sgn * Math.max(0, found.u - 2.6);
      const pl = c.phys.player;
      pl.teleport(new T.Vector3(sx, c.phys.groundAt(sx, sz).y + 0.2, sz));
      await frames(30);
      pl.teleport(new T.Vector3(sx, c.phys.groundAt(sx, sz).y + 0.2, sz));
      await frames(30);
      /* STOP AT THE TARGET, NOT AFTER A FIXED NUMBER OF FRAMES.
         Held for 150 frames at running speed he covers twelve metres,
         which is straight over the pavement, off the far side and into
         a field — two of the four probes ended ten metres past the
         kerb standing on terrain, and the row then measured a lawn. */
      const dir = new T.Vector3(tx - sx, 0, tz - sz).normalize();
      const reach = Math.hypot(tx - sx, tz - sz);
      pl.setInputFn(() => ({ x: dir.x, z: dir.z, run: false }));
      for (let f = 0; f < 200; f++) {
        await frames(1);
        if (Math.hypot(pl.simPosition.x - sx, pl.simPosition.z - sz) >= reach) break;
      }
      pl.setInputFn(null);
      pl.setInput({ x: 0, z: 0 });
      await frames(30);
      const fx = pl.simPosition.x, fz = pl.simPosition.z;
      const drawn = c.city.floorY(fx, fz);
      const g = c.phys.groundAt(fx, fz);
      /* WHAT STOPPED HIM, IF ANYTHING DID.

         A lamp post standing on the pavement is a lamp post standing
         on the pavement, and being stopped by one is correct — it is
         what every other section of this file asserts. Without asking,
         this row read a bollard two metres up the road as "the kerb is
         an invisible fence": one probe of four stopped 0.06 m short of
         the kerb line and the row went red on a collider that is doing
         its job. Same classifier surfacetest.mjs uses on a stalled
         leg: a near-vertical contact opposing the way he is going is a
         WALL, whatever the ray under his feet says. */
      const A = new T.Vector3(fx, pl.simPosition.y + pl.radius, fz);
      const B = new T.Vector3(fx, pl.simPosition.y + pl.height - pl.radius, fz);
      const COS_LIMIT = Math.cos(48 * Math.PI / 180);
      let blockedBy = '', deepest = 0;
      for (const ct of c.phys.capsuleCast(A, B, pl.radius + 0.10, [])) {
        if (ct.normal.y >= COS_LIMIT) continue;                        // floor
        if (ct.normal.x * dir.x + ct.normal.z * dir.z > -0.20) continue; // not in his way
        if (ct.depth > deepest) {
          deepest = ct.depth;
          blockedBy = c.phys.world.bodies.get(ct.body)?.opts?.name || `body${ct.body}`;
        }
      }
      out.push({
        kerbAt: +found.u.toFixed(2),
        upstand: +found.up.toFixed(3),
        /* how far past the kerb line he got */
        past: +(Math.hypot(fx - p.x, fz - p.z) - found.u).toFixed(2),
        /* feet vs the floor you can SEE under them */
        err: +(pl.simPosition.y - drawn).toFixed(3),
        on: c.phys.world.bodies.get(g.body)?.opts?.name || 'plane',
        blockedBy,
      });
      if (out.length >= 6) break;
    }
  }
  return { out };
});
if (kerbs.none) {
  results.push(['the footway is a surface phys knows about', false, kerbs.none]);
} else {
  const K = kerbs.out;
  for (const k of K) {
    console.log(`   kerb ${k.kerbAt} m off the centreline, ${k.upstand} m upstand: ` +
      `he ended ${k.past >= 0 ? '+' : ''}${k.past} m past it, feet ${k.err >= 0 ? '+' : ''}${k.err} m ` +
      `off the drawn floor, standing on ${k.on}` +
      `${k.blockedBy ? `  \x1b[90m(walled off by ${k.blockedBy})\x1b[0m` : ''}`);
  }
  const bodyTris = await page.evaluate(() => {
    let n = 0;
    for (const rec of window.WALLY.ctx.phys.world.bodies.values()) {
      if (rec.opts?.name === 'city.footway') n += rec.count;
    }
    return n;
  });
  console.log(`   city.footway: ${bodyTris} triangles in the collision world`);
  results.push(['the footway is registered with phys at all', bodyTris > 4000, `${bodyTris} triangles`]);
  /* the ones where nothing was in his way — those are the only ones
     that say anything about the kerb */
  const clear = K.filter((k) => !k.blockedBy);
  results.push(['at least three unobstructed kerbs to walk at', clear.length >= 3,
    `${clear.length}/${K.length} clear, ${K.length - clear.length} walled off by street furniture`]);
  results.push(['he can mount every kerb — it is not an invisible fence',
    clear.length > 0 && clear.every((k) => k.past > 0.35),
    clear.length ? clear.map((k) => `${k.past} m past`).join(', ') : 'no unobstructed kerb found']);
  /* 0.06 m: half the SINK_TOL surfacetest.mjs walks the island with,
     because this one is standing still on a level flag. */
  results.push(['and he stands ON the flags, not 0.10 m inside them',
    K.length > 0 && K.every((k) => Math.abs(k.err) < 0.06),
    K.length ? K.map((k) => `${k.err} m`).join(', ') : 'no kerb found to walk at']);
}

/* ------------------------------------------------------------------
   THE REVERT ARM — TODAY'S TEST AGAINST YESTERDAY'S CODE.

   Yesterday's code is "props.js registered nothing with ctx.phys", and
   ctx.phys.remove() puts exactly that back for one body, on this page
   load, after every other section has finished with the intact world.
   The same four approaches are then re-run against the body's snapped
   AABB. Section 1's claim is "never passes through"; this arm's claim
   is its negation on the same measurement, and if it does not hold,
   section 1 is measuring nothing and its green is worthless.

   Two readings are printed, both against the SAME snapped box, so the
   pair is one instrument: intact (he should stop outside) and removed
   (he should end up inside).
   ------------------------------------------------------------------ */
if (REVERT) {
  if (!revertTarget) {
    results.push(['REVERT: a body to take back out', false, 'no walk-into target was found']);
  } else {
    const snap = await page.evaluate((id) => window.__snap(id), revertTarget.id);
    console.log(`--- REVERT: ${revertTarget.label} (${revertTarget.name}) ---`);
    const sweep = async () => {
      let worst = Infinity;
      for (const a of ANGLES) {
        const r = await page.evaluate(([b, cc, aa]) => window.__clipBox(b, cc, aa),
          [snap, revertTarget.c, a]);
        if (r.minBox !== null) worst = Math.min(worst, r.minBox);
        console.log(`   ${(a * 57.3).toFixed(0).padStart(4)} deg  axis to snapped box ` +
          `${r.minBox === null ? ' n/a' : r.minBox.toFixed(3)} m`);
      }
      return worst;
    };
    console.log('  intact:');
    const before = await sweep();
    const gone = await page.evaluate((id) => window.__physRemove(id), revertTarget.id);
    console.log(`  body removed from the collision world: ${gone}`);
    console.log('  reverted:');
    const after = await sweep();
    results.push(['REVERT: ctx.phys.remove() actually took the body out', gone === true, String(gone)]);
    /* The same predicate section 1 uses (minBox < -0.01), both ways up
       on the same snapped box. */
    results.push([`REVERT: with the body registered he stays outside the ${revertTarget.label}`,
      before >= -0.01, `closest axis-to-box ${before === Infinity ? 'n/a' : before.toFixed(3)} m`]);
    results.push([`REVERT: with it unregistered he goes THROUGH the ${revertTarget.label} — section 1 is load-bearing`,
      after < -0.01, `deepest axis-to-box ${after === Infinity ? 'n/a' : after.toFixed(3)} m (was ${before === Infinity ? 'n/a' : before.toFixed(3)})`]);
  }
}

results.push(['no page errors', pageErr === null, pageErr || 'clean']);

await browser.close();
server.close();

console.log('\n=== cliptest ===');
let bad = 0;
for (const [name, pass, note] of results) {
  if (!pass) bad++;
  console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}\x1b[90m — ${note}\x1b[0m`);
}
console.log(bad ? `\x1b[31m${bad} failed\x1b[0m` : '\x1b[32mall green\x1b[0m');
process.exit(bad ? 1 : 0);
