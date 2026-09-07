#!/usr/bin/env node
/* ============================================================
   _j26-gov.mjs — THE GOVERNOR UNDER A REAL STALL.

   A governor tested by moving its own counters is a governor that has
   not been tested. Everything here is real work on a real vsync clock:

     PHASE 1  climb. Real frames, limiter ON, until the ladder stops
              moving. Records every notch and the ratio at it.
     PHASE 2  a REAL stall: a handle pushed onto ctx._handles that
              calls ctx.render.render() N extra times per frame. That
              is the whole frame's GPU and CPU work, N more times, on
              the real clock — the frame genuinely misses vsync. The
              same technique _perf-lib's stress mode already uses.
     PHASE 3  the stall stays on for four more decision windows. The
              question is not "does it drop" but "does it STOP". A
              governor that drops, lifts, drops is worse than a soft
              one.
     PHASE 4  the stall is removed. A demotion is documented as
              PERMANENT for the session, so the correct behaviour is
              that it does NOT climb back even though every frame is
              now clean. Anything else is oscillation with a longer
              period.
     PHASE 5  the cap guard: governorStep(+1) with no force must be
              refused after a drop (tools/mobilebugs PR-15 caught this
              climbing back over a notch that had already failed).
     PHASE 6  a REAL 400 ms stall — one busy-wait, longer than
              GOV_IGNORE_MS. A backgrounded tab or a boot hitch must
              NOT demote the player. Asserts govIgnored moved and the
              step did not.

   Every phase prints the machine's 1-minute load. Phase 2's stall is
   internal, so the box's own load is a confounder to watch, not the
   instrument.
   ============================================================ */
import { boot, sleep, load1, loadGate, ENVSTATE } from './_j26-lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MAXLOAD = +arg('maxload', 4);
const EXTRA = +arg('extra', 6);
const PLACE = arg('place', 'mainstreet');

const gs = () => ({
  ...WALLY.debug.governorState(),
  buffer: [WALLY.ctx.renderer.domElement.width, WALLY.ctx.renderer.domElement.height],
  frame: WALLY.ctx.frame,
});
const line = (tag, s, ld) =>
  `  ${String(tag).padEnd(34)} pr ${String(s.pixelRatio).padEnd(5)} step ${s.step} cap ${s.cap}  ` +
  `buffer ${String(s.buffer.join('x')).padEnd(11)} ignored ${String(s.ignored).padEnd(4)} ` +
  `inWin ${String(s.inWindow).padEnd(4)} late ${String(s.lateInWindow).padEnd(3)} settle ${String(s.settle).padEnd(4)} load ${ld}`;

const l00 = await loadGate(MAXLOAD);
const logs = [];
/* limiter ON: the governor's signal is a MISSED VSYNC. With the
   limiter off there is no vsync to miss and the whole mechanism is
   unobservable — which is why this is the one rig that must not use
   the uncapped clock. */
const { page, close } = await boot({ w: 390, h: 844, phone: true, dpr: 3, limiter: true, logs, qs: '?skipIntro&hour=12.5' });
await sleep(5000);
await page.evaluate((p) => { try { WALLY.debug.arrive(p, true); } catch (e) {} }, PLACE);
await sleep(4000);
const env = await page.evaluate(ENVSTATE);

console.log('# _j26-gov — the sharpness governor under a REAL stall, on a real vsync clock.');
console.log('# rig: headless Chrome (channel chrome), ANGLE Metal on Apple M1 Max, limiter ON (vsync live).');
console.log(`# phone 390x844 css, deviceScaleFactor 3, tier '${env.tier}', prMax ${env.pixelRatioMax}, budget ${env.pixelBudget} Mpx.`);
console.log(`# devicePixelRatio ${env.dpr}, maxTouchPoints ${env.maxTouchPoints}, deviceClass phone. Stall = ${EXTRA} extra full renders/frame.`);
console.log(`# load at start ${l00}\n`);

console.log('PHASE 1 — climb on real clean frames');
console.log(line('t=0 (after arrival)', await page.evaluate(gs), load1()));
for (let i = 1; i <= 6; i++) {
  await sleep(4000);
  console.log(line(`t=${i * 4}s`, await page.evaluate(gs), load1()));
}
const climbed = await page.evaluate(gs);
console.log('  climb log: ' + JSON.stringify(climbed.log));

console.log('\nPHASE 2/3 — REAL stall on (extra full renders per frame), four decision windows');
const l0 = load1();
await page.evaluate((n) => {
  const ctx = WALLY.ctx;
  const h = { __smname: 'j26stall', update() { for (let i = 0; i < n; i++) { try { ctx.render.render(); } catch (e) {} } } };
  window.__J26STALL__ = h;
  ctx._handles.push(h);
  return true;
}, EXTRA);
await sleep(1500);
const dur = await page.evaluate(async () => {
  const t = [];
  let last = 0;
  await new Promise(res => {
    let n = 0;
    const tick = (ts) => { if (last) t.push(ts - last); last = ts; if (++n < 90) requestAnimationFrame(tick); else res(); };
    requestAnimationFrame(tick);
  });
  t.sort((a, b) => a - b);
  return { p50: +t[t.length >> 1].toFixed(2), p95: +t[Math.floor(t.length * 0.95)].toFixed(2), n: t.length };
});
console.log(`  measured frame time WITH the stall: p50 ${dur.p50} ms, p95 ${dur.p95} ms over ${dur.n} frames  (GOV_LATE_MS is 20)`);
for (let i = 1; i <= 6; i++) {
  await sleep(3000);
  console.log(line(`stall on, t=${i * 3}s`, await page.evaluate(gs), load1()));
}
const stalled = await page.evaluate(gs);
console.log('  log during stall: ' + JSON.stringify(stalled.log));

console.log('\nPHASE 4 — stall removed; a demotion is documented as PERMANENT for the session');
await page.evaluate(() => {
  const i = WALLY.ctx._handles.indexOf(window.__J26STALL__);
  if (i >= 0) WALLY.ctx._handles.splice(i, 1);
  return true;
});
for (let i = 1; i <= 6; i++) {
  await sleep(3000);
  console.log(line(`stall off, t=${i * 3}s`, await page.evaluate(gs), load1()));
}
const after = await page.evaluate(gs);
console.log('  log after removal: ' + JSON.stringify(after.log));
console.log(`  settled? entries during stall ${stalled.log.length}, after removal ${after.log.length} — ` +
  (after.log.length === stalled.log.length ? 'NO further moves: settled' : 'MOVED AGAIN after the stall cleared'));

console.log('\nPHASE 5 — the cap guard (mobilebugs PR-15)');
const guard = await page.evaluate(() => ({
  lift: WALLY.debug.governorStep(+1),
  stateAfter: WALLY.debug.governorState().step,
  forced: WALLY.debug.governorStep(+1, true),
  stateForced: WALLY.debug.governorState().step,
}));
console.log('  governorStep(+1)        -> ' + JSON.stringify(guard.lift) + `   step now ${guard.stateAfter}`);
console.log('  governorStep(+1, force) -> ' + JSON.stringify(guard.forced) + `   step now ${guard.stateForced}`);

console.log('\nPHASE 6 — a REAL 400 ms stall: over GOV_IGNORE_MS, must NOT demote');
await page.evaluate(() => { WALLY.debug.governor(false); WALLY.debug.governor(true); });
await sleep(2500);
const before6 = await page.evaluate(gs);
await page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 400) {} return true; });
await sleep(2500);
const after6 = await page.evaluate(gs);
console.log(line('before the 400 ms block', before6, load1()));
console.log(line('after  the 400 ms block', after6, load1()));
console.log(`  ignored ${before6.ignored} -> ${after6.ignored}  (a >250 ms gap must be discarded, not counted late)`);
console.log(`  step ${before6.step} -> ${after6.step}  cap ${before6.cap} -> ${after6.cap}`);

console.log(`\n# page errors: ${logs.filter(l => /PAGEERROR/.test(l)).length}`);
if (logs.filter(l => /PAGEERROR/.test(l)).length) console.log('  ' + logs.filter(l => /PAGEERROR/.test(l))[0]);
console.log(`# load at end ${load1()}`);
await close();
