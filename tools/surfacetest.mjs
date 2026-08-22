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

     node tools/surfacetest.mjs [--verbose]
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

await page.evaluate(() => {
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
     module's ground group (heightfield, road ribbons, rock, grass lip)
     and the city root (foundations, berms, plaza pads, piers, steps).
     Everything else in the scene is either not ground (canopies, cloth,
     the sky dome, Wally himself) or actively lies about it — an outline
     hull is the same mesh pushed 2 mm along its normals, and a contact
     shadow is a dome that deliberately breaks through the surface.
     ---------------------------------------------------------------- */
  const SKIP = /outline|hull|contactShadow|cloth|drift|grass|foliage|detail|bush|reed|water|sky|cloud/i;
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

  /**
   * Walk from where he is toward (tx, tz), sampling every frame.
   * Returns the error series plus anything that caught him.
   */
  const bodyName = (id) => phys.world.bodies.get(id)?.opts?.name || (id ? `body${id}` : 'plane');

  window.__walk = async function walk(tx, tz, secs = 6, label = '') {
    const p = phys.player;
    const targets = collectTargets();
    const samples = [];
    let stalled = 0, lastD = Infinity;
    const catches = [];

    p.setInputFn(() => {
      const q = p.simPosition;
      const dx = tx - q.x, dz = tz - q.z;
      const l = Math.hypot(dx, dz) || 1;
      return { x: dx / l, z: dz / l, run: true };
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
           should have STEPPED OVER, so ask what the ground half a metre
           ahead of him is doing: within the 0.35 m step offset and he
           had every right to keep walking. */
        const dx = (tx - q.x) / d, dz = (tz - q.z) / d;
        const ahead = phys.groundAt(q.x + dx * 0.55, q.z + dz * 0.55);
        const rise = ahead.y - q.y;
        catches.push({
          x: +q.x.toFixed(1), z: +q.z.toFixed(1),
          rise: +rise.toFixed(2), on: bodyName(ahead.body),
          bad: ahead.hit && rise < 0.35,
        });
        break;
      }
      if (!p.grounded) continue;                 // airborne: nothing to compare
      const dy = drawnGround(q.x, q.z, q.y, targets);
      if (dy === null) continue;
      const g = phys.groundAt(q.x, q.z);
      samples.push({
        x: +q.x.toFixed(2), z: +q.z.toFixed(2),
        err: q.y - dy, sp: p.planarSpeed, on: `${bodyName(g.body)} vs ${drawnOn}`,
      });
    }
    p.setInputFn(null);
    p.setInput({ x: 0, z: 0 });

    let sink = 0, float = 0, sum = 0;
    let worstSink = null, worstFloat = null;
    for (const s of samples) {
      sum += s.err;
      if (s.err < sink) { sink = s.err; worstSink = s; }
      if (s.err > float) { float = s.err; worstFloat = s; }
    }
    return {
      label, n: samples.length, catches,
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

  window.__route = function route() {
    const W = c.world;
    const pts = [];
    for (const id of Object.keys(W.zones)) {
      const z = W.zones[id];
      pts.push({ id, x: z.world.x, z: z.world.z, r: z.world.radius });
    }
    return pts;
  };
});

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
    `${r.n === 0 ? '  \x1b[33mNO SAMPLES\x1b[0m' : ''}`);
  for (const ct of r.catches) {
    console.log(`        ${ct.bad ? '\x1b[31mCAUGHT' : '\x1b[90mstopped'}\x1b[0m at ${ct.x},${ct.z} — ` +
      `ground ${ct.rise >= 0 ? '+' : ''}${ct.rise} m ahead on ${ct.on}` +
      `${ct.bad ? '  (inside the 0.35 m step offset — he should have walked on)' : ''}`);
  }
  if (r.worstSink && r.sink < -SINK_TOL) {
    console.log(`        \x1b[33mworst sink\x1b[0m ${r.sink.toFixed(3)} m at ${r.worstSink.x},${r.worstSink.z} on ${r.worstSink.on}`);
  }
  if (r.worstFloat && r.float > FLOAT_TOL) {
    console.log(`        \x1b[33mworst float\x1b[0m ${r.float.toFixed(3)} m at ${r.worstFloat.x},${r.worstFloat.z} on ${r.worstFloat.on}`);
  }
}

/* ------------------------------------------------------------------
   The awkward surfaces, probed as static discs so a single bad pad or
   a decking seam cannot hide between two walk samples.
   ------------------------------------------------------------------ */
console.log('--- the awkward surfaces ---');
const spots = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const W = c.world;
  const out = [];
  /* a beach: walk out from the island centre until the shore is close */
  for (let a = 0; a < 6.28; a += 0.9) {
    for (let r = 40; r < 520; r += 6) {
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (W.heightAt(x, z) < 0.2) break;
      if (W.shoreDistAt(x, z) < 5) { out.push({ id: 'beach', x, z }); break; }
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

const probes = [];
for (const s of spots) {
  await page.evaluate(([x, z]) => window.__place(x, z), [s.x, s.z]);
  const d = await page.evaluate(() => window.__disc(6, 1.0));
  if (!d.length) { console.log(`   ${s.id.padEnd(26)} no drawn ground found`); continue; }
  let lo = 0, hi = 0, loOn = '', hiOn = '';
  for (const p of d) {
    if (p.err < lo) { lo = p.err; loOn = p.on; }
    if (p.err > hi) { hi = p.err; hiOn = p.on; }
  }
  probes.push({ id: s.id, lo, hi, n: d.length, loOn, hiOn });
  const flag = (lo < -SINK_TOL || hi > FLOAT_TOL) ? '\x1b[31m' : '';
  console.log(`   ${flag}${s.id.padEnd(26)}\x1b[0m ${String(d.length).padStart(4)} pts  ` +
    `collision below drawn ${lo.toFixed(3).padStart(7)} (${loOn || '-'})  ` +
    `above ${hi.toFixed(3).padStart(6)} (${hiOn || '-'})`);
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
  ['the awkward surfaces agree with what is drawn', badProbes.length === 0, badProbes.length ? badProbes.join(', ') : 'all within tolerance'],
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
