/* Does the kickstand actually reach the ground at PARK_LEAN, on all
   three machines, in a REAL park? And how wide are the props really —
   the number PARK_CLEAR_M is chosen against. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ wait: 4500 });
await page.evaluate(() => {
  window.__HOLD = () => {};
  const W = window.WALLY, c = W.ctx;
  window.__SPOT = { x: c.wally.root.position.x, z: c.wally.root.position.z };
});
for (const ride of ['bike', 'scooter', 'motorcycle']) {
  await page.evaluate((r) => { window.WALLY.debug.giveRide(r); }, ride);
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.WALLY.ctx.game.actions.equipRide(null); });
  await page.waitForTimeout(900);
  const r = await page.evaluate((rd) => {
    const W = window.WALLY, c = W.ctx, T = W.THREE;
    const p = c.wally.rideProps[rd], g = p.group;
    g.updateMatrixWorld(true);
    const s = g.getObjectByName('kickstand');
    if (!s) return { none: true };
    const b = new T.Box3().setFromObject(s);
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    const h = c.world.heightAt(cx, cz);
    /* the same point expressed in the GROUP's own frame, so the roll
       arithmetic in bike.js's comment can be checked directly */
    const local = new T.Vector3(b.min.x, b.min.y, cz).applyMatrix4(new T.Matrix4().copy(g.matrixWorld).invert());
    /* body width without the hulls */
    const bb = new T.Box3();
    g.traverse((o) => { if (o.isMesh && !o.userData.isOutlineHull && o.visible) bb.expandByObject(o); });
    const sz = bb.getSize(new T.Vector3());
    return { parked: c.wally.bikeState.parked.map((q) => q.id), standVisible: s.visible,
      rollDeg: +(g.rotation.z * 57.2958).toFixed(3),
      tipAboveTerrainMM: h == null ? null : +((b.min.y - h) * 1000).toFixed(1),
      groupYMinusTerrainMM: h == null ? null : +((g.position.y - h) * 1000).toFixed(1),
      tipLocalY: +local.y.toFixed(4),
      bodyWidthX: +sz.x.toFixed(3), bodyLengthZ: +sz.z.toFixed(3) };
  }, ride);
  P('STAND-' + ride, r);
  await page.evaluate(() => { window.WALLY.ctx.wally.setBike(false, { instant: true }); });
  await page.waitForTimeout(200);
}
P('ERRS', errs.slice(0, 6));
await close();
