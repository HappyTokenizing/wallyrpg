#!/usr/bin/env node
/* ============================================================
   _fa-stream2.mjs — the same A/B, with the flaw in _fa-stream.mjs
   fixed.

   THE FLAW. That rig walked each trial from the same arrival point
   over the same ground. Trial 1 built the chunks; trials 2 and 3 found
   them already built and streamed NOTHING, so the "new" rule read
   0.1 ms worst and so did the OLD rule on its second run. A rig that
   reports a fix where it re-ran the old code is measuring its own
   ordering. (It also ran at load average 202, which is not a rig.)

   THE FIX. WALLY.debug.foliageDrop() disposes every chunk before each
   trial, so both rules stream the SAME ground from bare, in the same
   order, and the comparison is matched. warmUntil is zeroed with it —
   the boot warm budget is 1.6 ms, not the 1.2 ms the game actually
   runs at, and measuring the warm one would flatter both rules.

   Trials alternate OLD/NEW/OLD/NEW so a drift in the box shows up as
   disagreement between the two OLDs rather than as a result.
   ============================================================ */
import { boot } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const W = +arg('w', 390), H = +arg('h', 844), WALK = +arg('walk', 7), REPS = +arg('reps', 2);
const load = () => execSync('uptime').toString().split('load averages:')[1].trim().split(/\s+/)[0];

const logs = [];
const { page, close } = await boot({ w: W, h: H, logs, limiter: false });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(6000);
console.log(`# ${W}x${H} dpr1, tier ${await page.evaluate(() => WALLY.ctx.quality.name)}, limiter OFF, ` +
  `M1 Max / ANGLE Metal / headless Chrome, ONE page load, chunks dropped before every trial`);

async function trial(fol, wor, place, tag) {
  await page.evaluate((p) => WALLY.debug.arrive(p, true), place);
  await page.waitForTimeout(2200);
  await page.evaluate(([f, w]) => { WALLY.debug.foliageStreamMode(f); WALLY.debug.worldStreamMode(w); }, [fol, wor]);
  const dropped = await page.evaluate(() => WALLY.debug.foliageDrop());
  await page.waitForTimeout(120);
  await page.keyboard.down('w');
  await page.waitForTimeout(WALK * 1000);
  await page.keyboard.up('w');
  const r = await page.evaluate(() => ({ fol: WALLY.debug.foliageStream(), wor: WALLY.debug.worldStream(), perf: WALLY.debug.perf() }));
  await page.waitForTimeout(400);
  const f = r.fol, w = r.wor, p = r.perf;
  console.log(`  ${tag.padEnd(24)} foliage-tail p95 ${String(f.frame.p95).padStart(5)} p99 ${String(f.frame.p99).padStart(5)} worst ${String(f.frame.worst).padStart(6)}` +
    ` | world-tail p95 ${String(w.p95).padStart(5)} worst ${String(w.worst).padStart(6)}` +
    ` | FRAME p50 ${String(p.p50).padStart(5)} p95 ${String(p.p95).padStart(5)} worst ${String(p.worst).padStart(6)}` +
    ` | rebuilt ${dropped.dropped}->${f.chunks} | load ${load()}`);
  return { f, w, p };
}

const PLACES = [['farm', 'Green Edge (quiet)'], ['mine', 'Iron Hills (quiet)'], ['markethall', 'Market Square (busy)']];
const med = a => { const v = a.slice().sort((x, y) => x - y); return v[v.length >> 1]; };

for (const [place, name] of PLACES) {
  console.log(`\n=== ${name} — walking W held ${WALK}s, ${REPS} matched pairs`);
  const oldW = [], newW = [], oldWorld = [], newWorld = [], oldFrame = [], newFrame = [];
  for (let r = 0; r < REPS; r++) {
    const o = await trial('chunk', 'count', place, `OLD  #${r + 1} chunk/count`);
    const n = await trial('layer', 'budget', place, `NEW  #${r + 1} layer/budget`);
    oldW.push(o.f.frame.worst); newW.push(n.f.frame.worst);
    oldWorld.push(o.w.worst); newWorld.push(n.w.worst);
    oldFrame.push(o.p.worst); newFrame.push(n.p.worst);
  }
  console.log(`  => foliage build-tail worst  OLD ${JSON.stringify(oldW)} med ${med(oldW)}  ->  NEW ${JSON.stringify(newW)} med ${med(newW)} ms`);
  console.log(`  => world  stream-tail worst  OLD ${JSON.stringify(oldWorld)} med ${med(oldWorld)}  ->  NEW ${JSON.stringify(newWorld)} med ${med(newWorld)} ms`);
  console.log(`  => whole-frame worst         OLD ${JSON.stringify(oldFrame)} med ${med(oldFrame)}  ->  NEW ${JSON.stringify(newFrame)} med ${med(newFrame)} ms`);
}

/* per-BAND grass cost — the number that says whether any scheduling
   fix at the foliage.js level could have worked at all */
await page.evaluate(() => { WALLY.debug.foliageStreamMode('layer'); WALLY.debug.arrive('farm', true); });
await page.waitForTimeout(2200);
await page.evaluate(() => WALLY.debug.foliageDrop());
await page.keyboard.down('w'); await page.waitForTimeout(10000); await page.keyboard.up('w');
const L = await page.evaluate(() => WALLY.debug.foliageStream());
console.log('\n# ONE LAYER BUILD, by layer and density band (Green Edge, walking, chunks dropped first).');
console.log('# band 0 is the densest, 4 the coarsest. The frame budget for the WHOLE tail is 1.2 ms.');
for (const [k, v] of Object.entries(L.layers).sort())
  console.log(`    ${k.padEnd(12)} n ${String(v.n).padStart(4)}  p50 ${String(v.p50).padStart(6)}  p95 ${String(v.p95).padStart(6)}  worst ${String(v.worst).padStart(6)} ms`);
console.log('# page errors:', logs.filter(l => /PAGEERROR/.test(l)).length, ' load', load());
await close();
