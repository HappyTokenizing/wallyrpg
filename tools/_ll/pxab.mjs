/* _ll/pxab.mjs — the two apparent-size instruments, side by side, on
   the same prop at the same instant.

   _ll/ladder.mjs captures the vertex list ONCE at setup and keeps the
   object references; _ll/px.mjs re-traverses the live graph at every
   range. They came back 10 to 30 % apart and the argument cannot be
   settled by reasoning about which is prettier. So: same frame, same
   position, both lists, plus the vertex counts and the mesh counts
   behind them. Whichever list is short is the wrong one. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();
await page.evaluate(() => { const a = window.WALLY.ctx.game.actions; a.grantRide('bike'); a.equipRide('bike'); });
await page.waitForTimeout(1800);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(1500);

await page.evaluate(() => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const g = c.wally.rideProps.bike.group;
  const grab = () => {
    const v = [], meshes = [];
    g.traverse((o) => {
      if (!o.isMesh || o.userData.isOutlineHull || !o.geometry?.attributes?.position) return;
      meshes.push(o);
      const pa = o.geometry.attributes.position, t = new T.Vector3();
      for (let i = 0; i < pa.count; i++) { t.fromBufferAttribute(pa, i); v.push([t.x, t.y, t.z, o]); }
    });
    return { v, meshes };
  };
  const early = grab();
  window.__B = {
    early,
    px(set) {
      const cam = c.camera, H = c.renderer.domElement.clientHeight, t = new T.Vector3();
      let y0 = 1e9, y1 = -1e9, n = 0, behind = 0, stale = 0;
      for (const [x, y, z, o] of set) {
        if (!o.parent) stale++;
        t.set(x, y, z); o.localToWorld(t); t.project(cam);
        if (t.z >= 1) { behind++; continue; }
        n++;
        const s = (-t.y * 0.5 + 0.5) * H;
        if (s < y0) y0 = s; if (s > y1) y1 = s;
      }
      return { px: n ? +(y1 - y0).toFixed(2) : null, used: n, behind, detached: stale, total: set.length };
    },
    at(d) {
      const cam = c.camera;
      const f = new T.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
      const x = cam.position.x + f.x * d, z = cam.position.z + f.z * d;
      let y = c.world?.heightAt?.(x, z); if (!Number.isFinite(y)) y = 0;
      g.position.set(x, y, z); g.updateMatrixWorld(true);
      const fresh = grab();
      const box = new T.Box3().setFromObject(g, true);
      const focal = (c.renderer.domElement.clientHeight * 0.5) / Math.tan((cam.fov * Math.PI / 180) * 0.5);
      return { d, camY: +cam.position.y.toFixed(2), propY: +y.toFixed(2),
        worldH: +(box.max.y - box.min.y).toFixed(3),
        thinLens: +(((box.max.y - box.min.y) * focal) / d).toFixed(2),
        earlyList: this.px(this.early.v), earlyMeshes: this.early.meshes.length,
        freshList: this.px(fresh.v), freshMeshes: fresh.meshes.length };
    },
  };
});

for (const d of [12, 32, 55.2, 57, 140.7]) {
  await page.evaluate((dd) => window.__B.at(dd), d);
  await page.waitForTimeout(300);           // let the loop cull hulls at this range
  P('ab', await page.evaluate((dd) => window.__B.at(dd), d));
}
P('ERRS', errs.slice(0, 4));
await close();
