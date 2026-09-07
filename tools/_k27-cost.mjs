#!/usr/bin/env node
/* ============================================================
   _k27-cost.mjs — WHAT EACH CORNER OF THE TRADE COSTS.

   _j26-cost measured the pixel-ratio axis. This measures the SURFACE:
   every (pixelRatio x msaa) pair, so "same GPU budget" is a number
   rather than an assumption. Same rig, same two clocks, same rule
   about load.

     limiter OFF   --disable-frame-rate-limit --disable-gpu-vsync. The
                   GPU cannot downclock into an idle gap, so this is
                   the only place the cost of a pixel or a sample is
                   visible at all. THE PREVIOUS BRIEF'S "GPU COST IS
                   FLAT ACROSS DPR" CAME FROM A CAPPED FRAME AND WAS AN
                   ARTEFACT OF THAT CLOCK.
     limiter ON    real vsync, i.e. what the governor sees: frames over
                   GOV_LATE_MS = 20 ms, which is the only signal a
                   quantised frame carries.

   ONE PAGE LOAD PER (viewport x clock) BLOCK. pixelRatio(v) and
   msaa(n) are both live now (renderer.js), so the whole matrix shares
   one world, one set of compiled programs and one GPU clock state.
   The FIRST combination is measured again at the bottom of the block:
   if * disagrees with its own first row, every row between them is
   contaminated. Load is read before AND after every row and printed.
   ============================================================ */
import { boot, sleep, load1, loadGate, ENVSTATE } from './_j26-lib.mjs';
/* _perf-lib's profiler, NOT _sm-lib's, and this is the whole point of
   the file. Under vsync the GPU has ~40 % idle and DOWNCLOCKS, so a
   timer query reads a slower clock the moment work is removed; with
   the limiter off instead, frames overlap and the query brackets a
   command stream that is no longer one frame's worth — measured here
   at gpuP50 10.82 ms inside an 8.6 ms frame, which is impossible and
   is the tell. _perf-lib re-renders the SAME frame `extra` extra times
   per rAF so the clock is pinned high, and queries each render
   individually. THAT is the instrument the msaa lines in
   QUALITY_TIERS were measured with (1600x900 h07.0 10.88 -> 13.87 ms),
   so these rows can be read against those. */
import { INJECT as PINJECT, NAMEHANDLES } from './_perf-lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SECS = +arg('secs', 6);
const PLACE = arg('place', 'cafe');
const MAXLOAD = +arg('maxload', 4);
const ONLY = arg('only', null);
const CLOCK = arg('clock', null);      // 'on' | 'off'
const HOUR = arg('hour', '12.5');
/* extra renders per rAF: 3 = four renders, exactly what the msaa rows
   in QUALITY_TIERS were taken at. 0 turns the saturation off. */
const EXTRA = +arg('extra', 3);

/* h07.0 is the expensive hour in the tier table (the shadowed half of
   the frame), h12.5 the cheap one. Both are worth having; --hour picks. */
const VIEWPORTS = [
  { label: 'desktop 1600x900 (no touch, tier high)', w: 1600, h: 900, phone: false, dsf: 2,
    combos: [[1, 0], [1, 2], [1, 4], [1.25, 0], [1.25, 2], [1.25, 4], [1.4, 0], [1.5, 0], [1.5, 2], [2, 0], [2, 4]] },
  { label: 'phone   390x844  (touch, mobile UA, tier med)', w: 390, h: 844, phone: true, dsf: 3,
    combos: [[1, 0], [2, 0], [2, 2], [2, 4], [3, 0]] },
];

const F = (s, n) => String(s).padEnd(n);
const R = (s, n) => String(s).padStart(n);

console.log('# _k27-cost — GPU and frame cost for every (pixelRatio x msaa) pair, load beside every number.');
console.log('# rig: headless Chrome (channel chrome), ANGLE Metal on Apple M1 Max (32-core GPU), 10 CPU cores, macOS 14.4.');
console.log(`# ?skipIntro&hour=${HOUR}, arrive('${PLACE}'), governor OFF, ratio pinned with WALLY.debug.pixelRatio(v), samples with WALLY.debug.msaa(n).`);
console.log(`# ONE page load per (viewport x clock) block, ${SECS} s per row. Load gated to <= ${MAXLOAD} once per BLOCK.`);
console.log('# A row marked * is the FIRST combination measured again at the end of the block — a drift check on the box, not a new setting.\n');

for (const V of VIEWPORTS) {
  if (ONLY && !V.label.startsWith(ONLY)) continue;
  for (const limiter of [false, true]) {
    if (CLOCK && (CLOCK === 'on') !== limiter) continue;
    const l00 = await loadGate(MAXLOAD);
    const logs = [];
    const { page, close } = await boot({ w: V.w, h: V.h, phone: V.phone, dpr: V.dsf, limiter, logs, qs: `?skipIntro&hour=${HOUR}` });
    await sleep(5000);
    const arrived = await page.evaluate((p) => { try { return WALLY.debug.arrive(p, true) === true; } catch (e) { return false; } }, PLACE);
    await sleep(6000);
    await page.evaluate(() => WALLY.debug.governor(false));
    await page.evaluate(NAMEHANDLES);
    await page.evaluate(PINJECT);
    await page.evaluate((n) => { window.__PROF__.extra = n; }, EXTRA);
    await sleep(1500);
    const env = await page.evaluate(ENVSTATE);
    const gpuName = env.gpu;
    const maxS = await page.evaluate(() => { const g = WALLY.ctx.renderer.getContext(); return g.getParameter(g.MAX_SAMPLES) | 0; });

    console.log(`=== ${V.label}   dsf ${V.dsf}   limiter ${limiter ? 'ON  (real vsync — what the governor sees)' : 'OFF (uncapped — what a pixel costs)'}`);
    console.log(`    tier '${env.tier}'  tier msaa ${env.msaa}  MAX_SAMPLES ${maxS}  prMax ${env.pixelRatioMax}  budget ${env.pixelBudget} Mpx  arrive('${PLACE}') ${arrived ? 'TRUE' : 'FALSE — shot at the boot position'}   GPU: ${String(gpuName).slice(0, 56)}`);
    console.log('    ' + F('pr', 6) + F('msaa', 6) + F('buffer', 12) + F('Mpx', 7) + R('gpuMs', 8) + R('rendCPU', 10) +
      R('cpuTot', 9) + R('wallMs', 8) + R('fps', 7) + R('calls', 8) + R('tris', 10) + '   load b/a');

    const plan = V.combos.concat([V.combos[0]]);
    for (let ci = 0; ci < plan.length; ci++) {
      const [pr, ms] = plan[ci];
      const l0 = load1();
      const set = await page.evaluate(([p, m]) => {
        WALLY.debug.pixelRatio(p);
        const got = WALLY.debug.msaa(m);
        return { got, vp: WALLY.debug.viewport() };
      }, [pr, ms]);
      await sleep(2500);                       // target realloc + shader recompile
      await page.evaluate(() => window.__PROF__.reset());
      await sleep(SECS * 1000);
      const r = await page.evaluate(() => window.__PROF__.read());
      const l1 = load1();
      const buf = `${set.vp.buffer[0]}x${set.vp.buffer[1]}`;
      const mpx = ((set.vp.buffer[0] * set.vp.buffer[1]) / 1e6).toFixed(3);
      const drift = ci === plan.length - 1;
      console.log('    ' + F(pr + (drift ? '*' : ''), 6) + F(set.got.samples, 6) + F(buf, 12) + F(mpx, 7) +
        R(r.gpuMs ?? '-', 8) + R(r.renderCpuPer ?? '-', 10) + R(r.cpuTotal ?? '-', 9) + R(r.wallMs, 8) + R(r.fps, 7) +
        R(r.calls, 8) + R(r.tris, 10) + `   ${l0} -> ${l1}   nGpu=${r.gpuN} x${1 + r.extra}`);
    }
    console.log('    page errors: ' + logs.filter(l => /PAGEERROR/.test(l)).length);
    console.log('');
    await close();
  }
}
console.log(`# load (1-min) at end: ${load1()}`);
