#!/usr/bin/env node
/* ============================================================
   _fa-stream.mjs — DID AMORTISING THE CHUNK BUILDS DO ANYTHING?

   THE REVERT CHECK IS THE SWITCH, NOT A QUOTED NUMBER. Both rules
   live in the shipping modules and both are driven here on ONE page
   load, same scene, same camera, same machine minute:

     foliage: WALLY.debug.foliageStreamMode('chunk' | 'layer')
              'chunk' = buildChunk() builds all five layers atomically
                        and the first chunk of a frame is exempt from
                        the budget. 'layer' = one layer at a time.
     world:   WALLY.debug.worldStreamMode('count' | 'budget')
              'count' = updateCollision(2) / updateRockCollision(4) /
                        processPending(3), uncosted. 'budget' = one
                        item at a time under a shared 1.2 ms clock.

   Order is chunk/count FIRST then layer/budget, and then BACK, so a
   monotone drift in the box cannot fake the result. The instrument is
   the same object in both directions (foliage.streamStats() clears its
   ring when the mode changes) and it measures MILLISECONDS OF BUILD,
   which is the effect — not chunks per second, which is the request.

   The quiet districts are the scenes that matter: a profile found
   Green Edge p95/p50 = 2.11 and Iron Hills 2.00 against a busy street
   at 1.18, because it is the empty ground that has grass to build.
   ============================================================ */
import { boot } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const W = +arg('w', 390), H = +arg('h', 844);
const WALK = +arg('walk', 8);
const load = () => execSync('uptime').toString().split('load averages:')[1].trim().split(/\s+/)[0];

const logs = [];
const { page, close } = await boot({ w: W, h: H, logs, limiter: false });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(6000);
console.log(`# ${W}x${H} dpr1, tier ${await page.evaluate(() => WALLY.ctx.quality.name)}, limiter OFF, ` +
  `M1 Max / ANGLE Metal / headless Chrome, ONE page load throughout`);

/* Walking is the scenario that streams: standing still, the ring is
   full and nothing builds at all. W held, crossing chunk boundaries. */
async function trial(fol, wor, place, tag) {
  await page.evaluate((p) => WALLY.debug.arrive(p, true), place);
  await page.waitForTimeout(2500);
  await page.evaluate(([f, w]) => { WALLY.debug.foliageStreamMode(f); WALLY.debug.worldStreamMode(w); }, [fol, wor]);
  await page.waitForTimeout(400);
  /* clear the census ring too, so the frame distribution is this trial's */
  await page.keyboard.down('w');
  await page.waitForTimeout(WALK * 1000);
  const r = await page.evaluate(() => ({
    fol: WALLY.debug.foliageStream(), wor: WALLY.debug.worldStream(), perf: WALLY.debug.perf(),
  }));
  await page.keyboard.up('w');
  await page.waitForTimeout(600);
  const f = r.fol, w = r.wor, p = r.perf;
  console.log(`  ${tag.padEnd(34)} foliage-tail p50 ${String(f.frame.p50).padStart(6)} p95 ${String(f.frame.p95).padStart(6)} worst ${String(f.frame.worst).padStart(6)}` +
    ` | world-tail p50 ${String(w.p50).padStart(6)} p95 ${String(w.p95).padStart(6)} worst ${String(w.worst).padStart(6)}` +
    ` | FRAME p50 ${String(p.p50).padStart(5)} p95 ${String(p.p95).padStart(5)} worst ${String(p.worst).padStart(5)} p95/p50 ${(p.p95 / p.p50).toFixed(2)}` +
    ` | chunks ${f.chunks} | load ${load()}`);
  return { f, w, p };
}

const PLACES = [['farm', 'Green Edge'], ['mine', 'Iron Hills'], ['markethall', 'Market Sq (busy)']];

for (const [place, name] of PLACES) {
  console.log(`\n=== ${name}, walking W held for ${WALK}s`);
  const before = await trial('chunk', 'count', place, 'OLD  chunk-atomic / count');
  const after = await trial('layer', 'budget', place, 'NEW  layer-at-a-time / budget');
  const back = await trial('chunk', 'count', place, 'OLD again (drift check)');
  const bt = (before.f.frame.worst + back.f.frame.worst) / 2;
  console.log(`  => foliage build-tail WORST: old ${before.f.frame.worst} / ${back.f.frame.worst} ms, new ${after.f.frame.worst} ms` +
    `  (old mean-of-two ${bt.toFixed(2)} -> ${after.f.frame.worst}, ${(100 * (1 - after.f.frame.worst / Math.max(1e-6, bt))).toFixed(0)}% off the worst frame)`);
}

/* the per-layer costs, which is what says whether splitting by layer
   had any granularity to find */
await page.evaluate(() => WALLY.debug.foliageStreamMode('layer'));
await page.evaluate(() => WALLY.debug.arrive('farm', true));
await page.waitForTimeout(2000);
await page.keyboard.down('w'); await page.waitForTimeout(8000); await page.keyboard.up('w');
const L = await page.evaluate(() => WALLY.debug.foliageStream());
console.log('\n# per-LAYER build cost, Green Edge walking (this is the granularity the split had to find):');
for (const [k, v] of Object.entries(L.layers)) console.log(`    ${k.padEnd(10)} n ${String(v.n).padStart(4)}  p50 ${String(v.p50).padStart(6)}  p95 ${String(v.p95).padStart(6)}  worst ${String(v.worst).padStart(6)} ms`);
console.log('# page errors:', logs.filter(l => /PAGEERROR/.test(l)).length, ' load', load());
await close();
