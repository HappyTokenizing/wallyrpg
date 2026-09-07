#!/usr/bin/env node
/* The after-distribution, read through the SHIPPED instrument
   (WALLY.debug.perf()) rather than the profiler, so the number quoted
   is the one the game itself publishes. Both viewports, three places,
   plus the first-sight window. */
import { boot, INJECT } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';
const load = () => execSync('uptime').toString().split('load averages:')[1].trim().split(' ')[0];

for (const [w, h] of [[1600, 900], [390, 844]]) {
  const logs = [];
  const { page, close } = await boot({ w, h, logs, limiter: true });
  await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
  await page.waitForTimeout(6000);
  console.log(`\n=== ${w}x${h}  quality ${await page.evaluate(() => WALLY.ctx.quality.name)}`);
  const read = async (tag, setup, hold) => {
    if (setup) await page.evaluate(setup);
    await page.waitForTimeout(hold ? 300 : 2600);
    if (hold) { await page.keyboard.down('w'); await page.waitForTimeout(3000); }
    const p = await page.evaluate(() => WALLY.debug.perf());
    if (hold) await page.keyboard.up('w');
    console.log(`  ${tag.padEnd(26)} p50 ${String(p.p50).padStart(5)}  p95 ${String(p.p95).padStart(5)}  p99 ${String(p.p99).padStart(5)}  worst ${String(p.worst).padStart(5)}  n ${String(p.n).padStart(3)}  | cpu ${String(p.cpuMs).padStart(5)}/${String(p.cpuP95).padStart(5)}  hz ${p.hz}  dropped ${p.dropped} (${p.dropPct}%)  calls ${p.calls}  load ${load()}`);
  };
  await read('quiet, spawn', null);
  await read('busy, market square', () => WALLY.debug.arrive('markethall', true));
  await read('walking, W held', () => WALLY.debug.arrive('cafe', true), true);
  /* first sight: read immediately, so the window is the arrival */
  await page.evaluate(() => WALLY.debug.arrive('office', true));
  await page.waitForTimeout(700);
  const f = await page.evaluate(() => WALLY.debug.perf());
  console.log(`  ${'first sight of a district'.padEnd(26)} p50 ${String(f.p50).padStart(5)}  p95 ${String(f.p95).padStart(5)}  p99 ${String(f.p99).padStart(5)}  worst ${String(f.worst).padStart(5)}  n ${String(f.n).padStart(3)}  | cpu ${String(f.cpuMs).padStart(5)}/${String(f.cpuP95).padStart(5)}  hz ${f.hz}  dropped ${f.dropped} (${f.dropPct}%)  calls ${f.calls}  load ${load()}`);
  console.log('  page errors:', logs.filter(l => /PAGEERROR/.test(l)).length);
  await close();
}
