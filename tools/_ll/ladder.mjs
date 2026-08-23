/* _ll/ladder.mjs — the draw-cost and apparent-size ladders, re-measured
   after a judge put the middle rows 40 to 75 calls out.

   THREE THINGS THIS DOES THAT THE LAST RIG DID NOT.

   1. THE MACHINE SITS ON THE TERRAIN. _kk/cost2.mjs dropped it at
      cam.position.y - 1.5, i.e. floating at eye height. Cascade
      membership is decided by where the caster IS, so a prop hovering
      in the middle of the frustum falls in cascades a bicycle standing
      in the street does not. heightAt puts it where the game would.
   2. THE LOOP RUNS BETWEEN MOVES. toon.js culls the §2.2 hulls once
      per FRAME; a prop moved and measured inside one synchronous
      evaluate is scored with the hull set from wherever it was last
      frame.
   3. EVERY RENDER RAISES shadowMap.needsUpdate AND RESETS info.
      renderer.js sets autoUpdate false and autoReset false; without
      both, the shadow column reads 0 at every range and the counts
      accumulate across passes.

   Cross-checked two ways at each rung: the deterministic two-render
   difference inside one evaluate, and an average over real animation
   frames with the prop toggled off by LAYER on alternate frames
   (parkedCull rewrites `visible` every frame, so `visible` cannot be
   used as the toggle from outside the loop). If the two disagree the
   number is not publishable. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();
await page.evaluate(() => { const a = window.WALLY.ctx.game.actions; a.grantRide('bike'); a.equipRide('bike'); });
await page.waitForTimeout(1800);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(1500);

await page.evaluate(() => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const g = c.wally.rideProps.bike.group;
  const verts = [];
  g.traverse((o) => {
    if (!o.isMesh || o.userData.isOutlineHull || !o.geometry?.attributes?.position) return;
    const pa = o.geometry.attributes.position, v = new T.Vector3();
    for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i); verts.push([v.x, v.y, v.z, o]); }
  });
  window.__L = {
    put(d, behind) {
      const cam = c.camera;
      const f = new T.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
      const s = behind ? -d : d;
      const x = cam.position.x + f.x * s, z = cam.position.z + f.z * s;
      let y = c.world?.heightAt?.(x, z);
      if (!Number.isFinite(y)) y = 0;
      g.position.set(x, y, z);
      g.updateMatrixWorld(true);
      return { at: [+x.toFixed(1), +y.toFixed(2), +z.toFixed(1)] };
    },
    /* apparent height in CSS pixels off the projected painted vertices
       (the hulls are a shell 1.6 px outside them and would inflate it) */
    px() {
      const cam = c.camera, el = c.renderer.domElement, H = el.clientHeight;
      const v = new T.Vector3();
      let y0 = 1e9, y1 = -1e9, n = 0;
      for (const [x, yy, z, o] of verts) {
        v.set(x, yy, z); o.localToWorld(v); v.project(cam);
        if (v.z >= 1) continue;
        n++;
        const y = (-v.y * 0.5 + 0.5) * H;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      return n ? +(y1 - y0).toFixed(1) : null;
    },
    read() {
      const r = c.renderer, cam = c.camera;
      const rd = () => { r.shadowMap.needsUpdate = true; r.info.reset(); r.render(c.scene, cam); return { calls: r.info.render.calls, tris: r.info.render.triangles }; };
      const was = g.visible;
      g.visible = true; rd(); const on = rd();
      g.visible = false; const off = rd();
      g.visible = was; rd();
      let hulls = 0, body = 0;
      g.traverse((o) => { if (o.isMesh) { if (o.userData.isOutlineHull) { if (o.visible) hulls++; } else body++; } });
      return { dist: +cam.position.distanceTo(g.position).toFixed(1), cullKeeps: was,
        hullsDrawn: hulls, bodyMeshes: body, pxCSS: this.px(),
        calls: on.calls - off.calls, tris: on.tris - off.tris };
    },
    /* the live-frame cross-check: layer 7 is on no camera, so an object
       moved onto it is skipped by the main pass AND by every shadow
       camera, which `visible` outside the loop cannot achieve here.

       THE MASK IS SAVED AND PUT BACK, NOT SET TO 0. wally.js enables
       SHADOW_LAYER (9) on every mesh in the prop so the blob-shadow
       projector's private camera can see it; restoring with
       layers.set(0) wipes that, the projector silently drops the
       machine, and every rung measured after the first one is a
       different scene from the one before it. Caught before it
       published a ladder — which is the whole reason this round
       exists. */
    async live(frames) {
      const r = c.renderer;
      const saved = [];
      g.traverse((o) => saved.push([o, o.layers.mask]));
      const on = [], off = [];
      for (let i = 0; i < frames; i++) {
        const hide = i % 2 === 1;
        for (const [o, m] of saved) { if (hide) o.layers.set(7); else o.layers.mask = m; }
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        (hide ? off : on).push(r.info.render.calls);
      }
      for (const [o, m] of saved) o.layers.mask = m;
      const m = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
      return { onAvg: +m(on).toFixed(1), offAvg: +m(off).toFixed(1), deltaAvg: +(m(on) - m(off)).toFixed(1) };
    },
  };
});

const D = [6, 12, 18, 24, 32, 40, 46, 55, 64, 80, 100, 122, 145];
for (const behind of [false, true]) {
  for (const d of D) {
    await page.evaluate(([dd, bb]) => window.__L.put(dd, bb), [d, behind]);
    await page.waitForTimeout(340);
    const a = await page.evaluate(() => window.__L.read());
    const l = await page.evaluate(() => window.__L.live(16));
    P(behind ? 'offscreen' : 'inframe', { want: d, ...a, live: l.deltaAvg });
  }
}
const meta = await page.evaluate(() => {
  const c = window.WALLY.ctx, el = c.renderer.domElement, cam = c.camera;
  const f = (el.clientHeight * 0.5) / Math.tan((cam.fov * Math.PI / 180) * 0.5);
  const T = window.WALLY.THREE;
  const g = c.wally.rideProps.bike.group;
  const b = new T.Box3().setFromObject(g, true);
  return { dpr: c.renderer.getPixelRatio(), css: [el.clientWidth, el.clientHeight],
    buffer: [el.width, el.height], fov: cam.fov, focalPx: +f.toFixed(1),
    worldH: +(b.max.y - b.min.y).toFixed(3) };
});
P('frame', meta);
P('ERRS', errs.slice(0, 4));
await close();
