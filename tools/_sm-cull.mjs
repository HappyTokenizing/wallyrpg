#!/usr/bin/env node
/* 827 of the scene's 2299 meshes carry frustumCulled = false and the
   frame issues 863 draw calls. Is the frame paying for geometry that is
   not on screen? Measured, not guessed: force culling ON for everything
   and difference the draw calls and the whole-frame GPU query.
   Interleaved rounds, min estimator (see _sm-bisect.mjs for why). */
import { boot, INJECT, stats } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';
const load = () => execSync('uptime').toString().split('load averages:')[1].trim();
const logs = [];
const { page, close } = await boot({ logs, limiter: true });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(6000);
await page.evaluate(INJECT);
await page.evaluate(() => WALLY.debug.arrive('markethall', true));
await page.waitForTimeout(3000);

await page.evaluate(() => {
  const s = WALLY.ctx.scene; const marked = [];
  s.traverse(o => { if (o.isMesh && o.frustumCulled === false) marked.push(o); });
  window.__CULL__ = {
    on() { for (const o of marked) o.frustumCulled = true; return marked.length; },
    off() { for (const o of marked) o.frustumCulled = false; return marked.length; },
    n: marked.length,
    kinds: (() => { const k = {}; for (const o of marked) { const t = o.isInstancedMesh ? 'instanced' : o.isSkinnedMesh ? 'skinned' : 'mesh'; k[t] = (k[t] || 0) + 1; } return k; })(),
  };
});
console.log('culled-off meshes:', JSON.stringify(await page.evaluate(() => ({ n: __CULL__.n, kinds: __CULL__.kinds }))), 'load', load());

async function win() {
  await page.evaluate(() => window.__SMP__.start('cull', 'frame'));
  await page.waitForTimeout(1800);
  await page.evaluate(() => window.__SMP__.stop());
  const d = await page.evaluate(() => window.__SMP__.read());
  const rec = d.rec.slice(1);
  return { gpu: stats(rec.filter(r => r.gpu != null).map(r => r.gpu)), wall: stats(rec.map(r => r.wall)),
    cpu: stats(rec.map(r => r.cpu)), calls: rec[rec.length >> 1]?.calls, tris: rec[rec.length >> 1]?.tris };
}

for (const view of ['street level', 'looking at the sky']) {
  if (view !== 'street level') await page.evaluate(() => { const c = WALLY.ctx.camera; c.rotation.x = 1.3; c.updateMatrixWorld(); });
  const dg = [], dc = [];
  let a0, b0;
  for (let r = 0; r < 4; r++) {
    await page.evaluate(() => __CULL__.off()); await page.waitForTimeout(400);
    const a = await win();
    await page.evaluate(() => __CULL__.on()); await page.waitForTimeout(400);
    const b = await win();
    await page.evaluate(() => __CULL__.off());
    dg.push(a.gpu.best - b.gpu.best); dc.push(a.calls - b.calls); a0 = a; b0 = b;
  }
  const m = (x) => +(x.reduce((s, v) => s + v, 0) / x.length).toFixed(2);
  console.log(`${view.padEnd(20)} calls ${a0.calls} -> ${b0.calls} (mean drop ${m(dc)})  tris ${a0.tris} -> ${b0.tris}  gpu min ${a0.gpu.best} -> ${b0.gpu.best}  saves ${m(dg)} ms  rounds ${dg.map(v => v.toFixed(2)).join(' ')}  load ${load().split(' ')[0]}`);
}
await close();
