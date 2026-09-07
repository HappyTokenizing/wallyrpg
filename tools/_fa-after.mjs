#!/usr/bin/env node
/* ============================================================
   _fa-after.mjs — the after-tail, per scene, through the SHIPPED
   instrument (WALLY.debug.perf()), so the number quoted is the one
   the game itself publishes and not a profiler's.

   Both limiter states, because they are different questions:
     ON  — how it is actually played. p50 pins to the vsync grid and
           the only honest stutter signal is `dropped`.
     OFF — where the tail lives, and the only state in which p95/p50
           says anything about headroom.

   Every row carries the machine load. This box has another agent's
   toolchain on it and _fa-contend.mjs measured the same scene at
   p50 7.6 quiet and 16.3 contended — a 2.1x swing with no code
   change — so a frame number without a load beside it is a rumour.
   ============================================================ */
import { boot } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const HOLD = +arg('hold', 5);
const load = () => execSync('uptime').toString().split('load averages:')[1].trim().split(/\s+/)[0];

const SCENES = [
  ['spawn (quiet)', null, false],
  ['Green Edge (quiet)', 'farm', false],
  ['Iron Hills (quiet)', 'mine', false],
  ['Market Square (busy)', 'markethall', false],
  ['Main St, walking', 'cafe', true],
];

for (const limiter of [false, true]) {
  for (const [w, h] of [[390, 844], [1600, 900]]) {
    const logs = [];
    const { page, close } = await boot({ w, h, logs, limiter });
    await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
    await page.waitForTimeout(6000);
    console.log(`\n=== ${w}x${h} dpr1  tier ${await page.evaluate(() => WALLY.ctx.quality.name)}  limiter ${limiter ? 'ON' : 'OFF'}` +
      `  | M1 Max, ANGLE Metal, headless Chrome`);
    for (const [tag, place, walk] of SCENES) {
      if (place) await page.evaluate((p) => WALLY.debug.arrive(p, true), place);
      await page.waitForTimeout(2600);
      if (walk) { await page.keyboard.down('w'); await page.waitForTimeout(HOLD * 1000); }
      else await page.waitForTimeout(HOLD * 1000);
      const p = await page.evaluate(() => WALLY.debug.perf());
      if (walk) await page.keyboard.up('w');
      console.log(`  ${tag.padEnd(22)} p50 ${String(p.p50).padStart(5)}  p95 ${String(p.p95).padStart(5)}  p99 ${String(p.p99).padStart(5)}  worst ${String(p.worst).padStart(6)}` +
        `  p95/p50 ${(p.p95 / p.p50).toFixed(2)}  | cpu ${String(p.cpuMs).padStart(5)}/${String(p.cpuP95).padStart(5)}  dropped ${String(p.dropped).padStart(3)} (${p.dropPct}%)  n ${String(p.n).padStart(3)}  calls ${p.calls}  | load ${load()}`);
    }
    /* first sight of a district never visited: read immediately, so
       the window IS the arrival rather than the calm after it */
    await page.evaluate(() => WALLY.debug.arrive('exchange', true));
    await page.waitForTimeout(700);
    const f = await page.evaluate(() => WALLY.debug.perf());
    console.log(`  ${'FIRST SIGHT Golden Hts'.padEnd(22)} p50 ${String(f.p50).padStart(5)}  p95 ${String(f.p95).padStart(5)}  p99 ${String(f.p99).padStart(5)}  worst ${String(f.worst).padStart(6)}` +
      `  p95/p50 ${(f.p95 / f.p50).toFixed(2)}  | cpu ${String(f.cpuMs).padStart(5)}/${String(f.cpuP95).padStart(5)}  dropped ${String(f.dropped).padStart(3)} (${f.dropPct}%)  n ${String(f.n).padStart(3)}  calls ${f.calls}  | load ${load()}`);
    console.log('  page errors:', logs.filter(l => /PAGEERROR/.test(l)).length);
    await close();
  }
}
