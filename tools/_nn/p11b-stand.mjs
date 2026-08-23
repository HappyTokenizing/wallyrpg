/* The kickstand, in a real park, on all three machines — measured the
   way p11 should have: park them the way p5 did (which worked), then
   read each stand's lowest point against the terrain under it. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ wait: 4500 });
await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  const p = c.wally.root.position, h = c.world.heightAt(p.x, p.z);
  const S = { x: p.x, y: Number.isFinite(h) ? h : p.y, z: p.z, yaw: c.wally.root.rotation.y };
  const t = () => { c.wally.setPosition(S.x, S.y, S.z); c.wally.setYaw(S.yaw); window.__H = requestAnimationFrame(t); };
  t();
});
for (const id of ['bike', 'scooter', 'motorcycle']) {
  await page.evaluate((i) => { window.WALLY.debug.giveRide(i); }, id);
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.WALLY.ctx.game.actions.equipRide(null); });
  await page.waitForTimeout(900);
}
const r = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx, T = W.THREE;
  const out = {};
  for (const id of ['bike', 'scooter', 'motorcycle']) {
    const p = c.wally.rideProps[id], g = p.group;
    g.updateMatrixWorld(true);
    const s = g.getObjectByName('kickstand');
    const b = new T.Box3().setFromObject(s);
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    const h = c.world.heightAt(cx, cz);
    /* the stand's own far end, in the machine's frame, after the roll */
    out[id] = { parked: c.wally.bikeState.parked.some((q) => q.id === id),
      inScene: g.parent === c.scene, standVisible: s.visible,
      rollDeg: +(g.rotation.z * 57.2958).toFixed(3), pitchDeg: +(g.rotation.x * 57.2958).toFixed(3),
      standTipAboveTerrainMM: h == null ? null : +((b.min.y - h) * 1000).toFixed(1),
      groupYAboveTerrainMM: h == null ? null : +((g.position.y - h) * 1000).toFixed(1),
      parkLean: p.parkLean };
  }
  return out;
});
for (const k of Object.keys(r)) P('STAND-' + k, r[k]);
P('ERRS', errs.slice(0, 6));
await close();
