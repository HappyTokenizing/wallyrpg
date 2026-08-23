/* _kk/cost2.mjs — the draw-cost ladder, measured across REAL frames.
   cost.mjs got a flat 106 at every range because toon.js culls outline
   hulls once per FRAME: a camera moved inside one synchronous evaluate
   measures the hull set from the last real frame, not from this range.
   So MOVE THE PARKED PROP instead, let the loop run, then difference
   renderer.info across two renders in one evaluate (autoReset is off;
   every render is bracketed by an explicit reset). */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();
await page.evaluate(() => { const a = window.WALLY.ctx.game.actions; a.grantRide('bike'); a.equipRide('bike'); });
await page.waitForTimeout(1800);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(1500);

await page.evaluate(() => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const g = c.wally.rideProps.bike.group;
  window.__K = {
    home: g.position.clone(),
    put(d, behind) {
      const cam = c.camera;
      const f = new T.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
      const s = behind ? -d : d;
      g.position.set(cam.position.x + f.x * s, cam.position.y - 1.5, cam.position.z + f.z * s);
      g.updateMatrixWorld(true);
      return { at: g.position.toArray().map((v) => +v.toFixed(1)) };
    },
    read() {
      const r = c.renderer, cam = c.camera;
      /* shadowMap.autoUpdate IS FALSE in this build (renderer.js sets
         it and raises needsUpdate once per frame), so a bare render()
         here reuses the last frame's shadow maps and the prop's shadow
         cost differences to ZERO. Raise it every render or the number
         published is the main pass only. */
      const rd = () => { r.shadowMap.needsUpdate = true; r.info.reset(); r.render(c.scene, cam); return { calls: r.info.render.calls, tris: r.info.render.triangles }; };
      const was = g.visible;
      g.visible = true; rd(); const on = rd();
      g.visible = false; const off = rd();
      g.visible = was; rd();
      let hulls = 0, meshes = 0;
      g.traverse((o) => { if (o.isMesh) { if (o.userData.isOutlineHull) { if (o.visible) hulls++; } else meshes++; } });
      const dist = +cam.position.distanceTo(g.position).toFixed(1);
      return { dist, cullVisible: was, hullsDrawn: hulls, bodyMeshes: meshes,
        calls: on.calls - off.calls, tris: on.tris - off.tris };
    },
  };
});

const D = [6, 12, 18, 24, 32, 40, 46, 55, 64, 80, 100, 122, 145];
for (const behind of [false, true]) {
  for (const d of D) {
    await page.evaluate(([dd, bb]) => window.__K.put(dd, bb), [d, behind]);
    await page.waitForTimeout(320);                       // ~19 real frames
    const a = await page.evaluate(() => window.__K.read());
    await page.waitForTimeout(120);
    const b = await page.evaluate(() => window.__K.read());
    P(behind ? 'offscreen' : 'inframe', { want: d, ...a, repeatCalls: b.calls, repeatTris: b.tris });
  }
}
P('ERRS', errs.slice(0, 4));
await close();
