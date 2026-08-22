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

     node tools/cliptest.mjs [--verbose]
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
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
let pageErr = null;
page.on('pageerror', (e) => { pageErr = e.message.split('\n')[0]; console.log('PAGEERROR', pageErr); });

await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 60000 });
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
   */
  window.__clip = async function clip(target, angle, dist = 4.0, secs = 2.6, mode = 'box') {
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
    let hp = null, hn = null;
    if (mode === 'plane') {
      for (const hy of [0.95, 0.55, 1.4, 0.3]) {
        const hit = phys.raycast(new T.Vector3(start.x, start.y + hy, start.z), toward, dist + 3);
        if (hit && hit.normal.y < 0.8) { hp = hit.point.clone(); hn = hit.normal.clone(); break; }
      }
      if (!hp) return { skip: 'no vertical face on the approach ray' };
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
      end: p.simPosition.toArray().map((v) => +v.toFixed(2)),
    };
  };

  window.__bodies = bodies;

  /** Is there a clear 0.34 m capsule at (x,z)? Used for door approaches. */
  window.__clearAt = function clearAt(x, z, r = 0.34, h = 1.62) {
    const g = phys.groundAt(x, z);
    const a = new T.Vector3(x, g.y + r + 0.02, z);
    const b = new T.Vector3(x, g.y + h - r, z);
    const hits = phys.capsuleCast(a, b, r);
    const who = new Set();
    for (const c2 of hits) {
      const rec = world.bodies.get(c2.body);
      who.add(rec?.opts?.name || `body${c2.body}`);
    }
    return { n: hits.length, who: [...who], y: +g.y.toFixed(2) };
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

const TARGETS = [
  ['bin', 'prop.bin'],
  ['bench', 'prop.bench'],
  ['lamp post', 'prop.lamp'],
  ['barrel', 'prop.barrel'],
  ['tree trunk', 'tree.'],
];

const results = [];
const ANGLES = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

for (const [label, prefix] of TARGETS) {
  const t = await pick(prefix);
  if (!t) {
    console.log(`--- ${label}: NOT FOUND in the collision world ---`);
    results.push([`${label} exists as a collider`, false, 'no body registered']);
    continue;
  }
  console.log(`--- ${label} (${t.name}, ${t.d} m away, ` +
    `${t.s.x.toFixed(2)}x${t.s.y.toFixed(2)}x${t.s.z.toFixed(2)} m) ---`);
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
     object — which is how a well-meant fix feels worse than the bug. */
  results.push([`${label}: gets close enough to touch`, closest < 0.34 + 0.14,
    `closest axis-to-surface ${closest === Infinity ? 'n/a' : closest.toFixed(3)} m (radius 0.34)`]);
}

/* ------------------------------------------------------------------
   1b. A building wall. The whole city is ONE merged collision body, so
   there is no convex box to test against — the face plane, gated to
   the frames where he is still in front of it, is the measurement.
   ------------------------------------------------------------------ */
const wall = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const p = c.phys.player.simPosition;
  let best = null;
  for (const [id, rec] of c.city.locations) {
    const d = Math.hypot(rec.center.x - p.x, rec.center.z - p.z);
    if (d > 8 && d < 140 && (!best || d < best.d)) best = { id, d, rec };
  }
  if (!best) return null;
  const cityId = [...c.phys.world.bodies].find(([, r]) => r.opts?.name === 'city')?.[0];
  return {
    id: cityId, loc: best.id,
    c: { x: best.rec.center.x, y: best.rec.groundY + 1.0, z: best.rec.center.z },
    yaw: best.rec.loc.yaw, d: +best.d.toFixed(1),
  };
});
if (wall) {
  console.log(`--- building wall (${wall.loc}, ${wall.d} m away) ---`);
  let clipped = 0, tried = 0, closest = Infinity;
  /* approach each of the four faces square on */
  for (const k of [0, 1, 2, 3]) {
    const a = wall.yaw + k * Math.PI / 2;
    const r = await page.evaluate(([tt, aa]) => window.__clip(tt, aa, 6.5, 3.0, 'plane'), [wall, a]);
    if (r.skip) { console.log(`   face ${k}  skip: ${r.skip}`); continue; }
    tried++;
    const through = r.minPlane !== null && r.minPlane < -0.01;
    if (through) clipped++;
    if (r.minPlane !== null) closest = Math.min(closest, r.minPlane);
    console.log(`   face ${k}  closest approach: face ${r.minPlane?.toFixed(3)} m  ` +
      `${through ? '\x1b[31mWENT THROUGH\x1b[0m' : 'stopped outside'}`);
  }
  results.push(['building wall: never passes through', tried > 0 && clipped === 0, `${clipped}/${tried} faces clipped`]);
  results.push(['building wall: gets close enough to touch', closest < 0.34 + 0.14,
    `closest axis-to-wall ${closest === Infinity ? 'n/a' : closest.toFixed(3)} m`]);
}

/* ------------------------------------------------------------------
   2. Every door must still be reachable.
   ------------------------------------------------------------------ */
console.log('--- doorway approaches ---');
const doors = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const T = window.WALLY.THREE;
  const out = [];
  for (const [id, rec] of c.city.locations) {
    const d = rec.door;
    if (!d) continue;
    const ax = Math.sin(rec.loc.yaw), az = Math.cos(rec.loc.yaw);
    let worst = 0;
    const who = new Set();
    /* walk the corridor the player has to use to reach the handle.
       The wall itself is at t = 0, so start clear of it. */
    for (const t of [1.0, 1.6, 2.2, 2.8]) {
      const r = window.__clearAt(d.x + ax * t, d.z + az * t);
      worst = Math.max(worst, r.n);
      for (const w of r.who) who.add(w);
    }
    out.push({ id, blocked: worst, who: [...who] });
  }
  return out;
});
const blockedDoors = doors.filter((d) => d.blocked > 0);
for (const d of blockedDoors) console.log(`   \x1b[31mBLOCKED\x1b[0m ${d.id} (${d.blocked} contacts: ${d.who.join(', ')})`);
console.log(`   ${doors.length - blockedDoors.length}/${doors.length} doors have a clear approach corridor`);
results.push(['every door approach is clear', blockedDoors.length === 0,
  blockedDoors.length ? blockedDoors.map((d) => d.id).join(', ') : 'all clear']);

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
