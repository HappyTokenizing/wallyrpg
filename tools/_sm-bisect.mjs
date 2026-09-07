#!/usr/bin/env node
/* ============================================================
   WHERE THE 10-14 ms GPU FRAME GOES — by A/B, not by per-pass timer
   query. THE PER-PASS QUERIES DO NOT WORK ON THIS GPU: one
   TIME_ELAPSED query around each of the 17 three.js render calls sums
   to 49.7 ms p50 on a frame the whole-frame query measures at 10.9 ms,
   and every pass reports a suspiciously identical ~2.8 ms. That is
   per-query flush overhead on a tile GPU, not the pass. So each
   candidate is measured by TURNING IT OFF and differencing the
   WHOLE-FRAME query, which has no such overhead.

   INTERLEAVED, because this machine's load moves under the
   measurement: baseline, variant, baseline, variant, ... and the
   reported delta is the mean of the per-round differences. A drift in
   load hits both arms of every round equally.
   ============================================================ */
import { boot, INJECT, stats } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';
const load = () => execSync('uptime').toString().split('load averages:')[1].trim();
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const W = +arg('w', 1600), H = +arg('h', 900), ROUNDS = +arg('rounds', 3), SECS = +arg('secs', 2.5);

const logs = [];
const { page, close } = await boot({ w: W, h: H, logs, limiter: true });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(6000);
await page.evaluate(INJECT);
await page.evaluate(() => WALLY.debug.arrive('markethall', true));
await page.waitForTimeout(3000);
console.log('# rig', JSON.stringify(await page.evaluate(() => ({ q: WALLY.ctx.quality?.name, size: [innerWidth, innerHeight], dpr: WALLY.ctx.renderer.getPixelRatio() }))), 'load', load());

async function win() {
  await page.evaluate(() => window.__SMP__.start('ab', 'frame'));
  await page.waitForTimeout(SECS * 1000);
  await page.evaluate(() => window.__SMP__.stop());
  const d = await page.evaluate(() => window.__SMP__.read());
  const rec = d.rec.slice(1);
  return { gpu: stats(rec.filter(r => r.gpu != null).map(r => r.gpu)), wall: stats(rec.map(r => r.wall)),
    cpu: stats(rec.map(r => r.cpu)), calls: rec[rec.length >> 1]?.calls };
}

/* [name, apply, restore] — every one is a runtime switch on the shipping
   build, driven on ONE page load. */
const CASES = [
  ['ssao off',        () => { WALLY.ctx.render.post.params.ssao = false; },  () => { WALLY.ctx.render.post.params.ssao = true; }],
  ['bloom off',       () => { WALLY.ctx.render.post.params.bloom = false; }, () => { WALLY.ctx.render.post.params.bloom = true; }],
  ['dof off',         () => { WALLY.ctx.render.post.params.dof = false; },   () => { WALLY.ctx.render.post.params.dof = true; }],
  ['fxaa off',        () => { WALLY.ctx.render.post.params.fxaa = false; },  () => { WALLY.ctx.render.post.params.fxaa = true; }],
  ['shadows off',     () => { WALLY.ctx.renderer.shadowMap.enabled = false; }, () => { WALLY.ctx.renderer.shadowMap.enabled = true; }],
  ['shadow map 1024', () => { WALLY.ctx.render.csm.setMapSize(1024); },      () => { WALLY.ctx.render.csm.setMapSize(2048); }],
  ['all post off',    () => { const p = WALLY.ctx.render.post.params; p.ssao = p.bloom = p.dof = p.fxaa = false; },
                      () => { const p = WALLY.ctx.render.post.params; p.ssao = p.bloom = p.dof = p.fxaa = true; }],
];

for (const [name, apply, restore] of CASES) {
  const dg = [], dw = [], dc = [];
  let a0, b0;
  for (let r = 0; r < ROUNDS; r++) {
    await page.evaluate(restore); await page.waitForTimeout(500);
    const a = await win();
    await page.evaluate(apply); await page.waitForTimeout(500);
    const b = await win();
    await page.evaluate(restore);
    /* THE ESTIMATOR IS THE MINIMUM, NOT THE MEDIAN. A TIME_ELAPSED
       query spans the GPU timeline, so every gap the scheduler gives
       another client (WindowServer is at 40-70% on this machine) lands
       INSIDE the measurement: the same build read gpu p50 34.4 ms and
       10.9 ms twenty seconds apart. The best frame in a window is the
       one that got the GPU to itself, so min is the estimator that
       survives contention; the medians are printed beside it so a
       reader can see how far apart the two are. */
    dg.push(a.gpu.best - b.gpu.best); dw.push(a.wall.p95 - b.wall.p95); dc.push(a.cpu.best - b.cpu.best);
    a0 = a; b0 = b;
  }
  const m = (x) => +(x.reduce((s, v) => s + v, 0) / x.length).toFixed(2);
  const sd = (x) => { const mu = x.reduce((s, v) => s + v, 0) / x.length; return +Math.sqrt(x.reduce((s, v) => s + (v - mu) ** 2, 0) / x.length).toFixed(2); };
  console.log(`${name.padEnd(17)} gpu min ${String(a0.gpu.best).padStart(6)} -> ${String(b0.gpu.best).padStart(6)}  saves ${String(m(dg)).padStart(6)} +-${String(sd(dg)).padStart(5)} ms   [p50 ${a0.gpu.p50}->${b0.gpu.p50}]  cpu saves ${m(dc)}  calls ${a0.calls}->${b0.calls}  load ${load().split(' ')[0]}`);
}
await close();
