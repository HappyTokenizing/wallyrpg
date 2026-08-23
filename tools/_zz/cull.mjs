/* _zz/cull.mjs — what a parked machine costs OFF SCREEN, measured in
   the live loop against a PRIVATE prop the cull cannot touch.

   The prop is built here from bike.js rather than borrowed from
   ctx.wally, so parkedCull() cannot hide it out from under the
   measurement and the number is about frustum culling and cascades
   alone. It is parked (leaned on its stand) and stood on the terrain at
   each range, because which cascade a caster falls in depends on where
   it actually is.

   node tools/_zz/cull.mjs
*/
import { boot } from '../_jj/lib.mjs';
const { page, errs, close } = await boot();

const out = await page.evaluate(async () => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const mod = await import('/src/character/bike.js');
  const prop = mod.createBike(c);
  prop.group.name = 'zz.private';
  prop.park(true);
  c.scene.add(prop.group);
  prop.group.visible = false;

  const cam = c.camera;
  const R = c.renderer;
  /* one real frame, and the calls it took. renderer.js resets
     info at the top of its own render, so reading it after a frame ends
     gives that frame's totals — including the shadow pass, which it
     re-renders every frame (shadowMap.needsUpdate is raised at step 2).
     A tool that calls renderer.render() itself and does not raise it
     reuses the last frame's shadow maps and reports 0 off screen at
     every range. */
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r({
    calls: R.info.render.calls, tris: R.info.render.triangles,
  }))));

  const place = (d) => {
    /* straight BEHIND the camera: -forward, at terrain height */
    const f = new T.Vector3();
    cam.getWorldDirection(f); f.y = 0; f.normalize();
    const p = cam.position.clone().addScaledVector(f, -d);
    const h = c.world.heightAt(p.x, p.z);
    prop.group.position.set(p.x, Number.isFinite(h) ? h : p.y, p.z);
    prop.group.updateMatrixWorld(true);
  };

  const rows = [];
  const RANGES = [4, 8, 12, 16, 20, 24, 32, 48, 64, 80, 100, 140];
  for (const d of RANGES) {
    place(d);
    let on = 0, off = 0, onT = 0, offT = 0;
    const N = 6;
    for (let i = 0; i < N; i++) {
      prop.group.visible = false; await frame();
      const a = await frame();
      prop.group.visible = true; await frame();
      const b = await frame();
      off += a.calls; on += b.calls; offT += a.tris; onT += b.tris;
    }
    /* is it in the frustum at all? it is behind the camera, so no */
    const inFrustum = (() => {
      const fr = new T.Frustum();
      fr.setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      const s = new T.Sphere(prop.group.position.clone(), 1.25);
      return fr.intersectsSphere(s);
    })();
    rows.push({ m: d, calls: +((on - off) / N).toFixed(1), tris: +((onT - offT) / N).toFixed(0), inFrustum });
  }
  prop.group.visible = false;
  c.scene.remove(prop.group);
  prop.dispose();
  const q = c.quality || {};
  const ri = W.debug.renderInfo ? W.debug.renderInfo() : {};
  return { tier: ri.quality || q.name || null, cascades: ri.cascades ?? null,
    dpr: R.getPixelRatio(),
    viewport: [R.domElement.width, R.domElement.height], rows };
});
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
