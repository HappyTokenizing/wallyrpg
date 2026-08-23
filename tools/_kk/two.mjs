/* _kk/two.mjs — park the bicycle and then the scooter WITHOUT MOVING.
   Before the offset ladder both landed on the same point. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();
const equip = async (id) => { await page.evaluate((i) => window.WALLY.ctx.game.actions.equipRide(i), id); await page.waitForTimeout(1900); };
await page.evaluate(() => { const a = window.WALLY.ctx.game.actions; a.grantRide('bike'); a.grantRide('scooter'); a.grantRide('motorcycle'); });
const at = (k) => page.evaluate((kk) => {
  const p = window.WALLY.ctx.wally.rideProps[kk];
  if (!p) return null;
  let stand = null; p.group.traverse((o) => { if (o.name === 'kickstand') stand = o.visible; });
  return { at: p.group.position.toArray().map((v) => +v.toFixed(3)), standOut: stand, leanDeg: +(p.group.rotation.z * 180 / Math.PI).toFixed(1) };
}, k);
const wally = () => page.evaluate(() => window.WALLY.ctx.wally.root.position.toArray().map((v) => +v.toFixed(3)));
await equip('bike'); await equip(null);
const b = await at('bike');
await equip('scooter'); await equip(null);
const sc = await at('scooter');
await equip('motorcycle'); await equip(null);
const m = await at('motorcycle');
const w = await wally();
const d = (a2, b2) => +Math.hypot(a2.at[0] - b2.at[0], a2.at[2] - b2.at[2]).toFixed(3);
P('wally', w);
P('bike', b); P('scooter', sc); P('motorcycle', m);
P('separation', { bikeScooter: d(b, sc), bikeMoto: d(b, m), scooterMoto: d(sc, m) });
/* LOOK AT IT. Aim the player's own camera at the row by dragging. */
for (let i = 0; i < 8; i++) {
  const q = await page.evaluate(() => {
    const c = window.WALLY.ctx, T = window.WALLY.THREE;
    const g = c.wally.rideProps.scooter.group; g.updateMatrixWorld(true);
    const b = new T.Box3().setFromObject(g, true).getCenter(new T.Vector3());
    const n = b.clone().project(c.camera);
    return { x: n.x, y: n.y, behind: n.z >= 1 };
  });
  if (!q.behind && Math.abs(q.x) < 0.25 && Math.abs(q.y) < 0.7) break;
  await page.mouse.move(640, 380); await page.mouse.down();
  for (let k = 1; k <= 6; k++) { await page.mouse.move(640 + (170 * k) / 6, 380); await page.waitForTimeout(35); }
  await page.mouse.up(); await page.waitForTimeout(600);
}
await page.waitForTimeout(900);
await page.screenshot({ path: '/tmp/kk-three-parked.png' });
P('ERRS', errs.slice(0, 4));
await close();
