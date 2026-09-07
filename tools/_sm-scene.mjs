#!/usr/bin/env node
/* How big is the scene graph the main forward pass walks every frame,
   and how much of R.gl0's CPU is the walk rather than the 830 draws? */
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

console.log('load', load());
console.log(JSON.stringify(await page.evaluate(() => {
  const s = WALLY.ctx.scene;
  let n = 0, mesh = 0, skinned = 0, inst = 0, vis = 0, cullOff = 0, mwAuto = 0, maxDepth = 0;
  (function walk(o, d) {
    n++; if (d > maxDepth) maxDepth = d;
    if (o.isMesh) mesh++; if (o.isSkinnedMesh) skinned++; if (o.isInstancedMesh) inst++;
    if (o.visible) vis++; if (o.frustumCulled === false) cullOff++;
    if (o.matrixWorldAutoUpdate) mwAuto++;
    for (const c of o.children) walk(c, d + 1);
  })(s, 0);
  /* time the two traversals three.js does per render, in isolation */
  const t0 = performance.now(); for (let i = 0; i < 20; i++) s.updateMatrixWorld(true); const tMW = (performance.now() - t0) / 20;
  const t1 = performance.now(); let k = 0; for (let i = 0; i < 20; i++) (function w(o){ k += o.visible ? 1 : 0; for (const c of o.children) w(c); })(s); const tWalk = (performance.now() - t1) / 20;
  return { nodes: n, meshes: mesh, skinned, instanced: inst, visible: vis, frustumCullOff: cullOff,
    matrixWorldAuto: mwAuto, maxDepth, updateMatrixWorldForcedMs: +tMW.toFixed(3), bareWalkMs: +tWalk.toFixed(3),
    calls: WALLY.ctx.renderer.info.render.calls, programs: WALLY.ctx.renderer.info.programs.length };
})), null, 0);
await close();
