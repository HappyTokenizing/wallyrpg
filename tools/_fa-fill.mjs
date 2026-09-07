#!/usr/bin/env node
/* ============================================================
   _fa-fill.mjs — THE DIMENSION NOBODY SAMPLED: devicePixelRatio.

   Every frame number in this project was taken at dpr 1. A real phone
   is 1170x2532. But note FIRST what the code does: every tier in
   QUALITY_TIERS sets pixelRatio: 1, and renderer.js's maxPixelRatio()
   clamps to q.pixelRatio, so THE GAME NEVER RENDERS ABOVE 1 no matter
   what the device reports. The rig prints the drawing buffer it got,
   which is how you tell a dpr that was applied from one that was asked
   for and thrown away.

   Then it lifts the clamp (q.pixelRatio = d; syncViewport(true), the
   shipped resize path) and measures what dpr 2 and 3 would actually
   cost — which is the only way to answer "is mobile fill-bound"
   honestly, because at dpr 1 a phone-shaped viewport has FEWER pixels
   than the desktop one it is being compared to.

   GPU time is EXT_disjoint_timer_query_webgl2 around ctx.render.render,
   which is the clock that owns the fill question. CPU is the census's
   in-step() wall clock. `uptime` load is printed beside every row
   because _fa-contend.mjs showed this box moves a p50 from 7 to 16 ms
   on contention alone.
   ============================================================ */
import { boot, INJECT, stats } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SECS = +arg('secs', 5);
const PLACE = arg('place', 'markethall');
const load = () => execSync('uptime').toString().split('load averages:')[1].trim().split(/\s+/)[0];

const VIEWPORTS = [[390, 844], [1600, 900]];
const DPRS = [1, 2, 3];

for (const [w, h] of VIEWPORTS) {
  const logs = [];
  const { page, close } = await boot({ w, h, logs, limiter: false });
  await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
  await page.waitForTimeout(6000);
  await page.evaluate((p) => WALLY.debug.arrive(p, true), PLACE);
  await page.waitForTimeout(3000);
  await page.evaluate(INJECT);
  await page.waitForTimeout(1000);

  const tier = await page.evaluate(() => WALLY.ctx.quality.name);
  console.log(`\n=== VIEWPORT ${w}x${h} css | tier ${tier} | ${PLACE} | limiter OFF | M1 Max, ANGLE Metal, headless Chrome`);
  console.log(`    ${'dpr'.padEnd(5)}${'buffer'.padEnd(13)}${'Mpx'.padEnd(7)}${'post'.padEnd(6)}  ${'gpuP50'.padStart(7)} ${'gpuP95'.padStart(7)} | ${'frameP50'.padStart(8)} ${'frameP95'.padStart(8)} | ${'cpuP50'.padStart(6)} | load`);

  for (const d of DPRS) {
    /* lift the tier's own clamp and go through the shipped resize path */
    const got = await page.evaluate((dd) => {
      WALLY.ctx.quality.pixelRatio = dd;
      WALLY.ctx.renderer.setPixelRatio(dd);
      WALLY.ctx.render.syncViewport(true);
      const gl = WALLY.ctx.renderer.getContext();
      return { pr: WALLY.ctx.renderer.getPixelRatio(), buf: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        sceneRT: [WALLY.ctx.render.targets.scene.width, WALLY.ctx.render.targets.scene.height] };
    }, d);
    await page.waitForTimeout(2500);

    for (const post of [true, false]) {
      await page.evaluate((p) => WALLY.ctx.render.setPost(p), post);
      await page.waitForTimeout(1800);
      await page.evaluate(() => window.__SMP__.start('fill', 'frame'));
      await page.waitForTimeout(SECS * 1000);
      await page.evaluate(() => window.__SMP__.stop());
      const r = await page.evaluate(() => window.__SMP__.read());
      const c = await page.evaluate(() => WALLY.debug.perf());
      const gpu = stats(r.rec.slice(1).map(x => x.gpu).filter(x => x != null));
      const mpx = (got.buf[0] * got.buf[1]) / 1e6;
      console.log(`    ${String(d).padEnd(5)}${(got.buf[0] + 'x' + got.buf[1]).padEnd(13)}${mpx.toFixed(2).padEnd(7)}${(post ? 'on' : 'OFF').padEnd(6)}  ` +
        `${String(gpu ? gpu.p50 : '-').padStart(7)} ${String(gpu ? gpu.p95 : '-').padStart(7)} | ${String(c.p50).padStart(8)} ${String(c.p95).padStart(8)} | ${String(c.cpuMs).padStart(6)} | ${load()}`);
    }
  }
  await page.evaluate(() => WALLY.ctx.render.setPost(true));
  console.log('    page errors:', logs.filter(l => /PAGEERROR/.test(l)).length);
  await close();
}
