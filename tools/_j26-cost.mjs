#!/usr/bin/env node
/* ============================================================
   _j26-cost.mjs — WHAT THE PIXELS COST, WITH THE LOAD BESIDE THEM.

   The previous measurement of this was FLAT across dpr on an M1 Max.
   That is the reason to be careful, not the reason to be confident:
   flat means the frame was submission-bound on THIS machine, and an
   M1 Max is not a phone. So this rig reports the two halves separately
   — GPU time from EXT_disjoint_timer_query_webgl2 around the whole
   draw, and CPU time from the wrapped subsystem hooks — because "flat
   total" with a rising GPU share is a completely different fact from
   "flat total" with a flat GPU share, and only the second one would
   survive the trip to a phone.

   TWO CLOCKS, ON PURPOSE:

     limiter OFF   --disable-frame-rate-limit --disable-gpu-vsync. The
                   GPU cannot downclock into an idle gap and the frame
                   is not quantised to 16.7 ms, so this is the only
                   place the COST of a pixel is visible at all.
     limiter ON    real vsync — which is what the governor is looking
                   at. Under vsync, headroom is invisible and the only
                   signal is a frame the compositor could not service,
                   so this block reports exactly that: frames over
                   20 ms (GOV_LATE_MS) per 60-frame window.

   LOAD IS READ BEFORE AND AFTER EVERY SAMPLE and printed on the row.
   A row whose load moved is a row to throw away; it is printed so it
   can be. This box has moved a p50 3-4x on contention alone.
   ============================================================ */
import { boot, sleep, load1, loadGate, ENVSTATE } from './_j26-lib.mjs';
import { INJECT, stats } from './_sm-lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SECS = +arg('secs', 6);
const PLACE = arg('place', 'mainstreet');
const MAXLOAD = +arg('maxload', 4);
const ONLY = arg('only', null);       // 'phone' | 'desktop'
const CLOCK = arg('clock', null);     // 'on' | 'off'
const HOUR = arg('hour', '12.5');     // SKY hour; the game-clock HUD is a different number

const VIEWPORTS = [
  { label: 'phone   390x844  (touch, mobile UA)', w: 390, h: 844, phone: true, dsf: 3, prs: [1, 1.5, 2, 3] },
  { label: 'desktop 1600x900 (no touch)', w: 1600, h: 900, phone: false, dsf: 2, prs: [1, 1.5, 2] },
];

const F = (s, n) => String(s).padEnd(n);
const R = (s, n) => String(s).padStart(n);

console.log('# _j26-cost — GPU and frame cost per pixel ratio, phone and desktop, load beside every number.');
console.log('# rig: headless Chrome (channel chrome), ANGLE Metal on Apple M1 Max, 10 cores, macOS 14.4.');
console.log(`# ?skipIntro&hour=${HOUR} (SKY hour — verified to hold at 11.5 s; the HUD clock is separate), arrive('${PLACE}'), governor OFF, ratio pinned with WALLY.debug.pixelRatio(v),`);
console.log(`# ONE page load per (viewport x clock) block, ${SECS} s per row. Load gated to <= ${MAXLOAD} once per BLOCK.`);
console.log('# A row marked * is the FIRST ratio measured again at the end of the block — a drift check on the box,');
console.log('# not a new setting. If * disagrees with its own first row, every row between them is contaminated.\n');

for (const V of VIEWPORTS) {
  if (ONLY && !V.label.startsWith(ONLY)) continue;
  for (const limiter of [false, true]) {
    if (CLOCK && (CLOCK === 'on') !== limiter) continue;
    const l00 = await loadGate(MAXLOAD);
    const logs = [];
    const { page, close } = await boot({ w: V.w, h: V.h, phone: V.phone, dpr: V.dsf, limiter, logs, qs: `?skipIntro&hour=${HOUR}` });
    await sleep(5000);
    await page.evaluate((p) => { try { WALLY.debug.arrive(p, true); } catch (e) {} }, PLACE);
    await sleep(6000);
    await page.evaluate(() => WALLY.debug.governor(false));
    await page.evaluate(INJECT);
    await sleep(1500);
    const env = await page.evaluate(ENVSTATE);
    const gpuName = await page.evaluate(() => window.__SMP__.gpuName);

    console.log(`=== ${V.label}   dsf ${V.dsf}   limiter ${limiter ? 'ON  (real vsync — what the governor sees)' : 'OFF (uncapped — what a pixel costs)'}`);
    console.log(`    tier '${env.tier}'  msaa ${env.msaa}  prMax ${env.pixelRatioMax}  budget ${env.pixelBudget} Mpx   GPU: ${String(gpuName).slice(0, 64)}`);
    console.log('    ' + F('pr', 6) + F('buffer', 12) + F('Mpx', 7) + R('gpuP50', 8) + R('gpuP95', 8) + R('frmP50', 8) +
      R('frmP95', 8) + R('cpuP50', 8) + R('calls', 8) + R('late>20', 9) + R('late%', 7) + '   load b/a');
    /* THE DRIFT ROW. The per-row load gate cannot work here: with the
       limiter off this rig's OWN browser renders flat out between rows
       and holds the 1-minute average up, so a gate would only ever
       time out. So the block is gated once at the top and then the
       FIRST ratio is measured AGAIN at the bottom. Two readings of the
       same setting, ~a minute apart, at whatever the box was doing:
       if they agree the block is internally consistent, and if they do
       not, every row between them is contaminated and the pair says so
       rather than the reader having to guess. */
    let rowN = 0;
    for (const pr of [...V.prs, V.prs[0]]) {
      const l0 = load1();
      const set = await page.evaluate((v) => { WALLY.debug.pixelRatio(v); return WALLY.debug.viewport(); }, pr);
      await sleep(2500);                       // target realloc + shader recompile
      await page.evaluate(() => window.__SMP__.start('cost', 'frame'));
      await sleep(SECS * 1000);
      await page.evaluate(() => window.__SMP__.stop());
      const r = await page.evaluate(() => window.__SMP__.read());
      const l1 = load1();
      const rec = r.rec.slice(2);
      const gpu = stats(rec.map(x => x.gpu).filter(x => x != null));
      const frm = stats(rec.map(x => x.raw));
      const cpu = stats(rec.map(x => x.cpu));
      const late = rec.filter(x => x.raw > 20 && x.raw <= 250).length;
      const calls = rec.length ? rec[rec.length - 1].calls : 0;
      const buf = `${set.buffer[0]}x${set.buffer[1]}`;
      const mpx = ((set.buffer[0] * set.buffer[1]) / 1e6).toFixed(3);
      console.log('    ' + F(pr === V.prs[0] && rowN++ > 0 ? pr + '*' : pr, 6) + F(buf, 12) + F(mpx, 7) + R(gpu ? gpu.p50 : '-', 8) + R(gpu ? gpu.p95 : '-', 8) +
        R(frm ? frm.p50 : '-', 8) + R(frm ? frm.p95 : '-', 8) + R(cpu ? cpu.p50 : '-', 8) + R(calls, 8) +
        R(late, 9) + R(rec.length ? (100 * late / rec.length).toFixed(1) : '-', 7) + `   ${l0} -> ${l1}   n=${rec.length}`);
    }
    console.log('    page errors: ' + logs.filter(l => /PAGEERROR/.test(l)).length);
    console.log('');
    await close();
  }
}
console.log(`# load (1-min) at end: ${load1()}`);
