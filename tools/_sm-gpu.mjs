#!/usr/bin/env node
/* WHERE THE GPU FRAME GOES. One TIME_ELAPSED query per three.js render
   call (they cannot nest, so the whole-frame query is off in this
   mode), then a second window with one query around the shadow map
   alone — which is INSIDE gl0 and so cannot be measured at the same
   time as it. Run at a busy street; state the load. */
import { boot, INJECT, stats } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';
const load = () => execSync('uptime').toString().split('load averages:')[1].trim();
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const W = +arg('w', 1600), H = +arg('h', 900);

const logs = [];
const { page, close } = await boot({ w: W, h: H, logs, limiter: !process.argv.includes('--nolimiter') });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(6000);
await page.evaluate(INJECT);
await page.evaluate(() => WALLY.debug.arrive('markethall', true));
await page.waitForTimeout(3000);

console.log('# rig', JSON.stringify(await page.evaluate(() => ({
  q: WALLY.ctx.quality?.name, dpr: WALLY.ctx.renderer.getPixelRatio(), size: [innerWidth, innerHeight],
  shadowType: WALLY.ctx.renderer.shadowMap.type, post: WALLY.ctx.render.post?.params,
}))), 'load', load());

for (const mode of ['pass', 'shadow', 'frame']) {
  await page.evaluate((m) => window.__SMP__.start('gpu-' + m, m), mode);
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.__SMP__.stop());
  await page.waitForTimeout(400);
  const d = await page.evaluate(() => window.__SMP__.read());
  const rec = d.rec.slice(1);
  console.log(`\n-- mode ${mode}   load ${load()}   frames ${rec.length}`);
  console.log('   wall', JSON.stringify(stats(rec.map(r => r.wall))));
  if (mode === 'frame') console.log('   gpu whole-frame', JSON.stringify(stats(rec.filter(r => r.gpu != null).map(r => r.gpu))));
  const rows = Object.entries(d.gpuPass).sort((a, b) => b[1].p50 - a[1].p50);
  let tot = 0;
  for (const [k, v] of rows) { tot += v.p50; console.log(`   ${k.padEnd(12)} p50 ${String(v.p50).padStart(7)} ms  p95 ${String(v.p95).padStart(7)}  n ${v.n}`); }
  if (rows.length) console.log(`   ${'SUM p50'.padEnd(12)}     ${tot.toFixed(3)} ms`);
  /* CPU medians beside them, same window */
  const keys = [...new Set(rec.flatMap(r => Object.keys(r.c)))];
  const cpu = keys.map(k => { const a = rec.map(r => r.c[k] || 0).sort((x, y) => x - y); return [k, +a[a.length >> 1].toFixed(2)]; })
    .filter(x => x[1] >= 0.1).sort((a, b) => b[1] - a[1]);
  console.log('   cpu medians:', JSON.stringify(cpu.slice(0, 12)));
}
await close();
