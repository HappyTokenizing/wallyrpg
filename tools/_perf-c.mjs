/* _perf-c.mjs — what is the CPU actually walking? Scene graph census
   plus a direct measurement of the three phases inside one render. */
import { boot, INJECT, NAMEHANDLES } from './_perf-lib.mjs';
const logs = [];
const { page, close } = await boot({ w: 1600, h: 900, logs });
await page.evaluate(NAMEHANDLES); await page.evaluate(INJECT);
await page.evaluate(() => { const d = window.WALLY.debug; d.arrive('cafe', true); d.arriveNow && d.arriveNow(); });
await page.waitForTimeout(2500);

const r = await page.evaluate(() => {
  const ctx = window.WALLY.ctx, sc = ctx.scene, T = window.WALLY.THREE;
  let objs = 0, meshes = 0, inst = 0, skinned = 0, hulls = 0, visibleMeshes = 0, autoMtx = 0, groups = 0, lights = 0;
  const byName = {};
  sc.traverse(o => {
    objs++;
    if (o.matrixAutoUpdate) autoMtx++;
    if (o.isLight) lights++;
    if (o.isMesh) { meshes++; if (o.visible) visibleMeshes++;
      if (o.isInstancedMesh) inst++; if (o.isSkinnedMesh) skinned++;
      if (o.userData.isOutlineHull) hulls++; }
    else if (o.isGroup) groups++;
  });
  for (const ch of sc.children) { let n = 0; ch.traverse(() => n++); byName[ch.name || ch.type] = n; }
  /* Phase timing: run the three stages of render() separately. */
  const renderer = ctx.renderer, cam = ctx.camera;
  const R = ctx.render;
  const t = (f, n = 40) => { f(); const a = performance.now(); for (let i = 0; i < n; i++) f();
    return +((performance.now() - a) / n).toFixed(3); };
  const mtx = t(() => sc.updateMatrixWorld(true), 30);
  const sm = renderer.shadowMap;
  const full = t(() => R.render(), 30);
  Object.defineProperty(sm, 'needsUpdate', { get: () => false, set: () => {}, configurable: true });
  const noShadow = t(() => R.render(), 30);
  Object.defineProperty(sm, 'needsUpdate', { value: true, writable: true, configurable: true });
  return { objs, meshes, visibleMeshes, inst, skinned, hulls, groups, lights, autoMtx, byName,
    ms: { updateMatrixWorld: mtx, render: full, renderNoShadow: noShadow },
    info: { calls: renderer.info.render.calls, tris: renderer.info.render.triangles,
      programs: renderer.info.programs.length, geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures } };
});
console.log(JSON.stringify(r, null, 1));
const errs = logs.filter(l => /PAGEERROR|\[error\]/.test(l));
if (errs.length) console.log('ERRORS ' + errs.slice(0, 5).join('\n'));
await close();
