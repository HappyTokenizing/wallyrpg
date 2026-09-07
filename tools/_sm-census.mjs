#!/usr/bin/env node
/* ============================================================
   THE REVERT CHECK for main.js's census clock.

   THE BRANCH THIS EXERCISES: main.js step(), the line
       ring[ringAt] = wall || rafGap;
   and collect()'s
       const v = censusClock === 'raf' ? rafRing[j] : ring[j];
   WALLY.debug.censusClock('raf') puts the shipped-before rule back —
   the ring reads requestAnimationFrame's timestamp — and this drives
   BOTH rules over THE SAME RINGS, i.e. the same frames, on one page
   load. Yesterday's rule must FAIL to report a hitch that today's
   reports, or the fix is not doing anything.

   THE HITCH IS INJECTED, not waited for, so the assertion is about a
   frame we know the length of. The stall is added from the test side
   (a wrapper over a handle's update) and never ships.
   ============================================================ */
import { boot, INJECT, stats } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';
const load = () => execSync('uptime').toString().split('load averages:')[1].trim();
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const STALL = +arg('stall', 12), EVERY = +arg('every', 15);

const logs = [];
const { page, close } = await boot({ logs, limiter: true });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(6000);
await page.evaluate(INJECT);
console.log('# rig', JSON.stringify(await page.evaluate(() => ({ q: WALLY.ctx.quality?.name, size: [innerWidth, innerHeight] }))), '1600x900 vsync, load', load());

const readBoth = () => page.evaluate(() => {
  const wall = (WALLY.debug.censusClock('wall'), WALLY.debug.perf());
  const raf = (WALLY.debug.censusClock('raf'), WALLY.debug.perf());
  WALLY.debug.censusClock('wall');
  const rings = WALLY.debug.frameRings();
  return { wall, raf, rings };
});

const show = (tag, r) => {
  const f = (o) => `p50 ${o.p50}  p95 ${o.p95}  p99 ${o.p99}  worst ${o.worst}  n ${o.n}`;
  console.log(`  ${tag}`);
  console.log(`    census clock=wall : ${f(r.wall)}   cpuMs ${r.wall.cpuMs} cpuP95 ${r.wall.cpuP95}  hz ${r.wall.hz} dropped ${r.wall.dropped} (${r.wall.dropPct}%)`);
  console.log(`    census clock=raf  : ${f(r.raf)}   <- the rule this replaced`);
  const w = r.rings.map(x => x[0]), a = r.rings.map(x => x[1]);
  console.log(`    rings, same frames: wall ${JSON.stringify(stats(w))}`);
  console.log(`                        raf  ${JSON.stringify(stats(a))}`);
};

/* ---- 1. steady state ---- */
await page.waitForTimeout(2500);
const quiet = await readBoth();
show('A  steady state, no injected stall', quiet);

/* ---- 2. with a known stall on every Nth frame ---- */
await page.evaluate(({ stall, every }) => {
  const h = WALLY.ctx._handles.find(x => x && typeof x.update === 'function');
  const f = h.update.bind(h);
  let n = 0;
  window.__STALL_OFF__ = () => { h.update = f; };
  h.update = function (...a) {
    const r = f(...a);
    if ((++n % every) === 0) { const t = performance.now(); while (performance.now() - t < stall); }
    return r;
  };
}, { stall: STALL, every: EVERY });
await page.waitForTimeout(3000);
const stalled = await readBoth();
show(`B  ${STALL} ms stall injected on every ${EVERY}th frame`, stalled);
await page.evaluate(() => window.__STALL_OFF__());

/* ---- the assertions ----
   ALL OF THEM ARE LOAD-INDEPENDENT, on purpose. An earlier draft
   asserted "clock=raf is flat at 16.7 in steady state" and that
   assertion failed on this machine the moment WindowServer took the
   GPU and the page settled at 30 fps instead — the ASSERTION was
   sampling one machine state, which is the failure this repo has paid
   for nine times. The property that is true at any refresh rate and
   any load is QUANTISATION: the rAF ring can only ever hold integer
   multiples of the panel period, so a frame that is 22.3 ms long is
   not representable in it at all. */
const fail = [];
const quant = (gaps, hz) => {
  if (!(hz > 1)) return null;
  let on = 0;
  for (const g of gaps) { const m = g / hz; if (Math.abs(m - Math.round(m)) * hz <= 0.6 && g < hz * 6) on++; }
  return +(on / gaps.length).toFixed(3);
};
const inWindow = (r) => { const n = Math.min(r.rings.length, Math.max(r.wall.n, r.raf.n)); return r.rings.slice(-n); };
const qr = inWindow(quiet), sr = inWindow(stalled);
const hz = quiet.wall.hz;
const qRaf = quant(qr.map(x => x[1]), hz), qWall = quant(qr.map(x => x[0]), hz);
const sRaf = quant(sr.map(x => x[1]), hz), sWall = quant(sr.map(x => x[0]), hz);
console.log(`\n  quantisation to the ${hz} ms panel period — share of frames landing on the grid:`);
console.log(`    steady state:   raf ${qRaf}   wall ${qWall}`);
console.log(`    with the stall: raf ${sRaf}   wall ${sWall}`);

/* THE PRECONDITION, AND IT IS NOT AN ASSERTION ABOUT THE FIX. The
   comparison only means anything while the compositor is holding ONE
   period. On a contended machine Chrome slides between 16.7, 33.3 and
   50 ms and the rAF samples stop landing on any single grid — this
   check then refuses to certify rather than passing for the wrong
   reason, which is the failure mode this repo has paid for nine
   times. Re-run it on a quiet machine; the load is printed above. */
if (!(qRaf >= 0.95 && sRaf >= 0.95))
  fail.push(`VOID, NOT FAILED: the compositor is not holding one period on this machine (hz ${hz}, ${qRaf} / ${sRaf} of rAF samples on that grid). The wall/raf comparison needs a stable limiter. Machine load: ${load()}`);
if (!(sWall <= 0.6))
  fail.push(`REVERT CHECK DID NOT FAIL: with a ${STALL} ms stall running, ${sWall} of wall samples still landed on the grid, so the wall ring is not carrying a real duration`);
if (!(stalled.wall.cpuP95 >= quiet.wall.cpuP95 + STALL * 0.6))
  fail.push(`cpuP95 did not see the stall (${quiet.wall.cpuP95} -> ${stalled.wall.cpuP95}), so the in-frame CPU clock is not measuring the frame`);
if (!(stalled.wall.p95 >= quiet.wall.p50 + STALL * 0.3))
  fail.push(`the injected ${STALL} ms stall did not reach the wall ring (p50 ${quiet.wall.p50} -> p95 ${stalled.wall.p95})`);
/* The old clock's ONLY vocabulary for the stall is a whole dropped
   frame. Either it reports nothing, or it reports one period too many
   — never the 22.3 ms the frame took. */
const rafRise = +(stalled.raf.p95 - quiet.raf.p50).toFixed(2);
const offGrid = Math.abs(rafRise / hz - Math.round(rafRise / hz)) * hz;
if (!(offGrid <= 0.6))
  fail.push(`clock=raf reported an off-grid rise of ${rafRise} ms, which it should not be able to represent`);
if (!(quiet.wall.cpuMs > 1 && quiet.wall.cpuMs < quiet.wall.p50))
  fail.push(`cpuMs ${quiet.wall.cpuMs} is not a plausible in-frame CPU time under a ${quiet.wall.p50} ms frame`);

console.log(`  p95 under stall: wall ${quiet.wall.p95} -> ${stalled.wall.p95} ms;  raf ${quiet.raf.p95} -> ${stalled.raf.p95} ms (blind)`);
console.log(`  cpuP95 under stall: ${quiet.wall.cpuP95} -> ${stalled.wall.cpuP95} ms`);
console.log(fail.length ? '\nFAIL\n  ' + fail.join('\n  ') : '\nPASS  every assertion above held, and clock=raf failed to see the stall.');
console.log('page errors:', logs.filter(l => /PAGEERROR/.test(l)).length);
await close();
process.exit(fail.length ? 1 : 0);
