#!/usr/bin/env node
/* ============================================================
   _fa-world.mjs — the world stream budget, on its own.

   The foliage layer-split lost (see foliage.js) and is reverted, so
   this A/Bs the one change that is left: world.js driving terrain.js's
   three queues one item at a time under a shared 1.2 ms clock instead
   of with three uncosted counters (updateCollision 2, rock 4,
   processPending 3).

   Matched: every chunk dropped before each trial so both rules stream
   the same ground from bare; OLD/NEW alternated so a drift in the box
   shows up as disagreement between the two OLDs. `uptime` load beside
   every row.
   ============================================================ */
import { boot } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const W = +arg('w', 390), H = +arg('h', 844), WALK = +arg('walk', 7), REPS = +arg('reps', 3);
const LIM = process.argv.includes('--limiter');
const load = () => execSync('uptime').toString().split('load averages:')[1].trim().split(/\s+/)[0];

const logs = [];
const { page, close } = await boot({ w: W, h: H, logs, limiter: LIM });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(6000);
console.log(`# ${W}x${H} dpr1, tier ${await page.evaluate(() => WALLY.ctx.quality.name)}, limiter ${LIM ? 'ON' : 'OFF'}, ` +
  `M1 Max / ANGLE Metal / headless Chrome, one page load, chunks dropped before every trial`);

async function trial(mode, place, tag) {
  await page.evaluate((p) => WALLY.debug.arrive(p, true), place);
  await page.waitForTimeout(2200);
  await page.evaluate((m) => { WALLY.debug.worldStreamMode(m); WALLY.debug.foliageDrop(); }, mode);
  await page.waitForTimeout(120);
  await page.keyboard.down('w');
  await page.waitForTimeout(WALK * 1000);
  await page.keyboard.up('w');
  const r = await page.evaluate(() => ({ w: WALLY.debug.worldStream(), p: WALLY.debug.perf() }));
  await page.waitForTimeout(400);
  console.log(`  ${tag.padEnd(22)} world-tail p50 ${String(r.w.p50).padStart(5)} p95 ${String(r.w.p95).padStart(5)} p99 ${String(r.w.p99).padStart(5)} worst ${String(r.w.worst).padStart(6)}` +
    ` | FRAME p50 ${String(r.p.p50).padStart(5)} p95 ${String(r.p.p95).padStart(5)} p99 ${String(r.p.p99).padStart(5)} worst ${String(r.p.worst).padStart(6)} drop ${String(r.p.dropped).padStart(3)} | load ${load()}`);
  return r;
}

const med = a => { const v = a.slice().sort((x, y) => x - y); return v[v.length >> 1]; };
const PLACES = [['farm', 'Green Edge (quiet)'], ['mine', 'Iron Hills (quiet)'], ['markethall', 'Market Square (busy)'], ['exchange', 'Golden Heights']];

for (const [place, name] of PLACES) {
  console.log(`\n=== ${name} — walking ${WALK}s, ${REPS} matched pairs`);
  const ow = [], nw = [], of = [], nf = [], o95 = [], n95 = [];
  for (let r = 0; r < REPS; r++) {
    const o = await trial('count', place, `OLD #${r + 1} counters`);
    const n = await trial('budget', place, `NEW #${r + 1} 1.2ms budget`);
    ow.push(o.w.worst); nw.push(n.w.worst); of.push(o.p.worst); nf.push(n.p.worst);
    o95.push(o.p.p95); n95.push(n.p.p95);
  }
  console.log(`  => world stream-tail WORST   OLD ${JSON.stringify(ow)} med ${med(ow)}  ->  NEW ${JSON.stringify(nw)} med ${med(nw)} ms`);
  console.log(`  => whole-frame p95           OLD ${JSON.stringify(o95)} med ${med(o95)}  ->  NEW ${JSON.stringify(n95)} med ${med(n95)} ms`);
  console.log(`  => whole-frame WORST         OLD ${JSON.stringify(of)} med ${med(of)}  ->  NEW ${JSON.stringify(nf)} med ${med(nf)} ms`);
}
console.log('\n# page errors:', logs.filter(l => /PAGEERROR/.test(l)).length, ' load', load());
await close();
