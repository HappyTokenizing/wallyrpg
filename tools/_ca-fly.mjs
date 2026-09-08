/* _ca-fly.mjs — THE THING ITSELF: a balloon let down onto a real wood.

   Order matters. Find a wood, put the player in it so its collision
   streams in, board the machine through the game's own flight path
   (which is what registers the canopies), PROVE THE WOOD ANSWERS A RAY
   before flying anything at it, then sink onto it with the wind at
   zero and a hand on the stick holding station — the same pinned
   descent tools/test-balloon.mjs B5e uses, so the two are comparable.
   Then take the canopies away mid-flight and sink again: the
   counter-case that says it was the crowns that held her.
*/
import { boot, ROOT } from './_ca-lib.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const { page, errs, close } = await boot({ settle: 5000 });
const OUT = join(ROOT, 'shots/canopy');
await mkdir(OUT, { recursive: true });
const J = (o) => JSON.stringify(o);

/* ---- 1. the thickest wood on the island, and the player put in it.
   trees.js already knows where that is — bestView() scores a pose by
   how many trees land in its frame, which is what foliage.js's own
   'grove' shot uses — so the site is the game's answer, not mine. */
const wood = await page.evaluate(async () => {
  const T3 = WALLY.THREE, t = WALLY.ctx.foliage.trees, W = WALLY.ctx.world, w = WALLY.ctx.wally;
  const v = t.bestView(50, 26);
  const rows = t.crownBoxes();
  let best = null;
  for (const r of rows) {
    const d = Math.hypot(r.x - v.tx, r.z - v.tz);
    let n = 0;
    for (const o of rows) if (Math.hypot(o.x - r.x, o.z - r.z) < 12) n++;
    const score = n - d * 0.35;
    if (!best || score > best.score) best = { score, n, d, r };
  }
  const r = best.r;
  w.controller.teleport(new T3.Vector3(r.x + 9, W.heightAt(r.x + 9, r.z) + 1, r.z));
  await new Promise((k) => setTimeout(k, 2600));
  return { n: best.n, view: [+v.px.toFixed(1), +v.pz.toFixed(1)], x: r.x, z: r.z, kind: r.kind,
    s: +r.s.toFixed(2), low: +r.lowOverBase.toFixed(2), high: +r.highOverBase.toFixed(2), gy: +W.heightAt(r.x, r.z).toFixed(2) };
});
console.log('WOOD  ' + J(wood));

/* ---- 2. board it: the gate is the game's own 'wally:fly' ---- */
const gate = await page.evaluate(async () => {
  const t = WALLY.ctx.foliage.trees;
  const before = { crowns: t.crownCount, on: t.canopiesOn };
  WALLY.debug.balloon();
  await new Promise((k) => setTimeout(k, 900));
  const after = { crowns: t.crownCount, on: t.canopiesOn, phase: WALLY.debug.balloonInfo().phase };
  return { before, after };
});
console.log('GATE  on foot ' + J(gate.before) + '  ->  aboard ' + J(gate.after));

/* ---- 3. THE JUDGE'S OWN CENSUS, re-run with the machine aloft ----
   0 of 40 sampled trees answered a horizontal ray at 4.0, 5.5 or 7.0 m
   and 1 of 40 had any solid above 3 m. Same question, same heights. */
const census = await page.evaluate(() => {
  const T3 = WALLY.THREE, phys = WALLY.ctx.phys, world = WALLY.ctx.world;
  const hit = { point: new T3.Vector3(), normal: new T3.Vector3(), distance: 0, tri: -1, body: 0, plane: false };
  const spots = [];
  const m = new T3.Matrix4(), v = new T3.Vector3();
  WALLY.ctx.scene.traverse((ob) => {
    if (!ob.isInstancedMesh || !/^tree\.(broadleaf|pine|palm)/.test(ob.name || '') || /outline/.test(ob.name)) return;
    for (let i = 0; i < ob.count && spots.length < 600; i++) {
      ob.getMatrixAt(i, m); v.setFromMatrixPosition(m); v.applyMatrix4(ob.matrixWorld);
      spots.push([v.x, v.z]);
    }
  });
  const step = Math.max(1, Math.floor(spots.length / 40));
  let sampled = 0, solidHigh = 0, ray = { 4.0: 0, 5.5: 0, 7.0: 0 };
  const org = new T3.Vector3(), dir = new T3.Vector3(1, 0, 0);
  const tops = [];
  for (let i = 0; i < spots.length && sampled < 40; i += step) {
    const [x, z] = spots[i];
    const gy = world.heightAt(x, z);
    sampled++;
    const top = phys.groundAt(x, z).y - gy;
    tops.push(+top.toFixed(2));
    if (top >= 3.0) solidHigh++;
    /* the judge's horizontal ray: 5 m out, aimed at the axis */
    for (const h of [4.0, 5.5, 7.0]) {
      org.set(x - 5, gy + h, z);
      if (phys.raycast(org, dir, 10, hit)) ray[h]++;
    }
  }
  tops.sort((a, b) => b - a);
  return { sampled, solidHigh, ray, tops: tops.slice(0, 8), tallest: tops[0] };
});
console.log('CENSUS aloft: ' + census.solidHigh + ' of ' + census.sampled + ' tree axes carry a solid above 3 m; ' +
  'horizontal ray answered at 4.0 m by ' + census.ray['4'] + ', at 5.5 m by ' + census.ray['5.5'] + ', at 7.0 m by ' + census.ray['7'] +
  ' of ' + census.sampled + '.  tallest solid ' + census.tallest + ' m, top 8 ' + J(census.tops));

/* ---- 4. the descent, twice ---- */
const fly = await page.evaluate(async (site) => {
  const T3 = WALLY.THREE, phys = WALLY.ctx.phys, w = WALLY.ctx.wally, t = WALLY.ctx.foliage.trees;
  const FIT = WALLY.debug.balloonInfo().fit;
  const hit = { point: new T3.Vector3(), normal: new T3.Vector3(), distance: 0, tri: -1, body: 0, plane: false };
  const windWas = WALLY.ctx.wind.uniforms.uWindStrength.value;
  WALLY.ctx.wind.setStrength(0);
  const gy = site.gy;
  /* the rig can reach its subject: a ray from 8 m out at mid-crown */
  const mid = gy + (site.low + site.high) * 0.5;
  const side = phys.raycast(new T3.Vector3(site.x - 8, mid, site.z), new T3.Vector3(1, 0, 0), 16, hit);
  const overhead = +(phys.groundAt(site.x, site.z).y - gy).toFixed(2);
  /* SINK UNTIL SHE STOPS, don't sink for a fixed number of seconds.
     The first cut of this ran 13 s, which was enough over open ground
     and not enough over a wood — she was still falling at 2.85 m/s when
     the clock ran out, and the run reported that as her resting height.
     A descent is over when vy has been ~0 for a second, or never. */
  const descend = async (maxMs) => {
    WALLY.debug.balloon({ alt: 1, at: [site.x, gy + 0.3, site.z] });
    WALLY.debug.balloon({ alt: 7 });          // 7 m over whatever is under her
    WALLY.debug.balloonStick(0, 0);
    await new Promise((r) => setTimeout(r, 150));
    const trace = [];
    const t0 = performance.now();
    let still = 0, settledAt = null;
    while (performance.now() - t0 < maxMs) {
      await new Promise((r) => requestAnimationFrame(r));
      const p = w.position;
      WALLY.debug.balloonStick(
        Math.max(-1, Math.min(1, (site.x - p.x) * 0.35)),
        Math.max(-1, Math.min(1, (site.z - p.z) * 0.35)));
      trace.push(+(p.y - gy).toFixed(2));
      const vy = Math.abs(w.flightState.vy);
      still = vy < 0.02 ? still + 1 : 0;
      if (still > 45 && settledAt === null) { settledAt = +((performance.now() - t0) / 1000).toFixed(1); break; }
    }
    WALLY.debug.balloonStick(null, null);
    const s = w.flightState;
    const every = Math.max(1, Math.floor(trace.length / 12));
    return {
      restOverTerrain: +(w.position.y - gy).toFixed(2),
      off: +Math.hypot(w.position.x - site.x, w.position.z - site.z).toFixed(2),
      vy: +s.vy.toFixed(3), alt: +s.alt.toFixed(2), settledAt,
      trace: trace.filter((_, i) => i % every === 0),
    };
  };
  const withCanopy = await descend(45000);
  const crownsDuring = t.crownCount;
  t.setCanopies(false);                       // the counter-case
  const without = await descend(45000);
  t.setCanopies(true);
  WALLY.ctx.wind.setStrength(windWas);
  return { reach: { side: side ? +side.distance.toFixed(2) : null, overhead }, withCanopy, without, crownsDuring };
}, wood);

console.log('REACH  a ray from 8 m out at mid-crown hits at ' + fly.reach.side + ' m; the solid overhead is ' + fly.reach.overhead + ' m over the terrain');
console.log('HELD   ' + fly.crownsDuring + ' crowns live.  rest ' + fly.withCanopy.restOverTerrain + ' m over the terrain (crown ' +
  wood.low + '-' + wood.high + '), ' + fly.withCanopy.off + ' m off the mark, vy ' + fly.withCanopy.vy + ', settled at ' + fly.withCanopy.settledAt + ' s');
console.log('       descent trace (m over terrain) ' + J(fly.withCanopy.trace));
console.log('NOT    crowns dropped mid-flight: rest ' + fly.without.restOverTerrain + ' m, vy ' + fly.without.vy +
  ', settled at ' + fly.without.settledAt + ' s  — a difference of ' + (fly.withCanopy.restOverTerrain - fly.without.restOverTerrain).toFixed(2) + ' m');
console.log('       descent trace ' + J(fly.without.trace));

/* ---- 5. put her back on the wood and photograph it ---- */
const shot = await page.evaluate(async (site) => {
  const T3 = WALLY.THREE, w = WALLY.ctx.wally, W = WALLY.ctx.world;
  WALLY.ctx.wind.setStrength(0);
  WALLY.debug.balloon({ alt: 1, at: [site.x, site.gy + 0.3, site.z] });
  WALLY.debug.balloon({ alt: 7 });
  const t0 = performance.now();
  let still = 0;
  while (performance.now() - t0 < 45000) {
    await new Promise((r) => requestAnimationFrame(r));
    const p = w.position;
    WALLY.debug.balloonStick(
      Math.max(-1, Math.min(1, (site.x - p.x) * 0.35)),
      Math.max(-1, Math.min(1, (site.z - p.z) * 0.35)));
    still = Math.abs(w.flightState.vy) < 0.02 ? still + 1 : 0;
    if (still > 45) break;
  }
  WALLY.debug.balloonStick(null, null);
  const s = w.flightState;
  return { phase: s.phase, alt: +s.alt.toFixed(2), vy: +s.vy.toFixed(3), ground: +s.ground.toFixed(2),
    y: +w.position.y.toFixed(2), crowns: WALLY.ctx.foliage.trees.crownCount,
    restOverTerrain: +(w.position.y - site.gy).toFixed(2) };
}, wood);
await page.waitForTimeout(1200);
await page.screenshot({ path: join(OUT, 'held-by-the-wood.png'), timeout: 60000 });

/* and again from the side, so the basket and the crowns are in the
   same frame at the same height rather than one behind the other */
await page.evaluate((site) => {
  const T3 = WALLY.THREE, w = WALLY.ctx.wally, W = WALLY.ctx.world;
  const p = w.position;
  const a = 2.1;
  const pos = new T3.Vector3(p.x + Math.cos(a) * 21, Math.max(p.y + 1.5, W.heightAt(p.x, p.z) + 6), p.z + Math.sin(a) * 21);
  WALLY.ctx.cam.override(pos, new T3.Vector3(p.x, p.y - 1.2, p.z), 46);
}, wood);
await page.waitForTimeout(1400);
await page.screenshot({ path: join(OUT, 'held-by-the-wood-side.png'), timeout: 60000 });
console.log('SHOT   shots/canopy/held-by-the-wood.png + -side.png  ' + J(shot));
if (errs.length) console.log('ERRORS', errs.slice(0, 8));
await close();
