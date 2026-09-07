#!/usr/bin/env node
/* ============================================================
   _j26-lift.mjs — DOES THE GOVERNOR ACTUALLY LIFT, AND WHEN NOT?

   tools/mobilebugs.mjs PR-9..PR-12 is the shipping gate for the pixel
   ratio. Run here it goes 16/16 GREEN — and its own printed table says
   the governor took ZERO lifts at devicePixelRatio 2 AND 3 and left
   the backing store at 390x844, which is the exact frame the change
   exists to replace. It is green because PR-9 asserts the tier
   CEILING (a pure function) and PR-10 asserts the BOOT ratio (1, by
   construction). Nothing in the suite asserts that the ratio ever
   rises on a real clock — so the gate cannot go red on the day the
   feature delivers nothing.

   Minutes earlier, on the same box, tools/_j26-first.mjs watched the
   same viewport climb 1 -> 1.5 -> 2 in about six seconds. So one of
   the two runs is being decided by something other than the rule. The
   candidates are the ones that differ between them, and this varies
   them one at a time:

     · the boot query string  (?skipIntro  vs  ?skipIntro&hour=12.5)
     · where the camera is    (spawn       vs  arrive('mainstreet'))

   Each row prints the frame-time p50 the governor was looking at, how
   many frames it called late, whether it lifted, and the load either
   side. GOV_LATE_MS is 20 ms and this machine's p50 sits within a
   millisecond of it, which is the whole story if it turns out to be
   the story.
   ============================================================ */
import { boot, sleep, load1, loadGate } from './_j26-lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MAXLOAD = +arg('maxload', 5);
const REPS = +arg('reps', 2);
const ONLY = arg('only', null);   // 'A' | 'B' | 'C' | 'D'

const CASES = [
  ['A  ?skipIntro            spawn        (mobilebugs PR-9 conditions)', '?skipIntro', null],
  ['B  ?skipIntro&hour=12.5  spawn', '?skipIntro&hour=12.5', null],
  ['C  ?skipIntro            mainstreet', '?skipIntro', 'mainstreet'],
  ['D  ?skipIntro&hour=12.5  mainstreet   (_j26-first conditions)', '?skipIntro&hour=12.5', 'mainstreet'],
];

const F = (s, n) => String(s).padEnd(n);
const R = (s, n) => String(s).padStart(n);

console.log('# _j26-lift — the governor is looking at a frame time one millisecond from its own threshold.');
console.log('# phone 390x844 CSS, hasTouch + isMobile + Pixel 7 UA, deviceScaleFactor 3, limiter ON (real vsync).');
console.log('# 13.5 s of frames after ready, exactly as mobilebugs PR-9 waits. GOV_LATE_MS = 20 ms, GOV_DROP_LATE = 3/60.\n');
console.log('  ' + F('case', 62) + R('pr@13.5s', 9) + R('lifts', 7) + R('frmP50', 8) + R('frmP95', 8) +
  R('late>20', 9) + R('n', 6) + R('cpuP50', 8) + '   buffer        load b/a');

for (const [label, qs, place] of CASES) {
  if (ONLY && label[0] !== ONLY) continue;
  for (let rep = 0; rep < REPS; rep++) {
    await loadGate(MAXLOAD);
    const l0 = load1();
    const logs = [];
    const { page, close } = await boot({ w: 390, h: 844, phone: true, dpr: 3, limiter: true, logs, qs });
    await sleep(1500);
    if (place) { await page.evaluate((p) => { try { WALLY.debug.arrive(p, true); } catch (e) {} }, place); }
    /* record every rAF delta for the whole decision period, so the
       number quoted is the one the governor was actually shown */
    await page.evaluate(() => {
      window.__J26T__ = [];
      let last = 0;
      const tick = (ts) => { if (last) window.__J26T__.push(ts - last); last = ts; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    await sleep(12000);
    const out = await page.evaluate(() => {
      const t = window.__J26T__.slice();
      const s = t.slice().sort((a, b) => a - b);
      const q = (p) => (s.length ? +s[Math.min(s.length - 1, Math.round((s.length - 1) * p))].toFixed(2) : null);
      return {
        vp: WALLY.debug.viewport(), gov: WALLY.debug.governorState(),
        p50: q(0.5), p95: q(0.95), n: t.length,
        late: t.filter(x => x > 20 && x <= 250).length,
        cpu: window.__WALLY_PERF__ ? window.__WALLY_PERF__.cpuMs : null,
        hour: (() => { try { return WALLY.ctx.sky && WALLY.ctx.sky.hour; } catch (e) { return null; } })(),
      };
    });
    const l1 = load1();
    console.log('  ' + F(label + (REPS > 1 ? `  #${rep + 1}` : ''), 62) + R(out.vp.pixelRatio, 9) +
      R(out.gov.log.filter(x => /lift/.test(x.why)).length, 7) + R(out.p50, 8) + R(out.p95, 8) +
      R(out.late, 9) + R(out.n, 6) + R(out.cpu, 8) + `   ${F(out.vp.buffer.join('x'), 12)}  ${l0} -> ${l1}` +
      (logs.filter(l => /PAGEERROR/.test(l)).length ? '  ERRORS' : ''));
    console.log('       log: ' + out.gov.log.map(g => `${g.from}->${g.to} @f${g.frame} (${g.why})`).join('  |  '));
    await close();
  }
}
console.log(`\n# load (1-min) at end: ${load1()}`);
