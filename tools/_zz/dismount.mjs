/* _zz/dismount.mjs — a REAL gameplay dismount, not a probe. Grants the
   ride, equips it, rides a little, then unequips through
   ctx.game.actions — the only dismount the game has — and measures the
   machine it left behind: both wheel contacts and the kickstand's
   lowest painted vertex, against ctx.world.heightAt. Then looks at it.
   node tools/_zz/dismount.mjs <ride> <out.png>
*/
import { boot } from '../_jj/lib.mjs';
const RIDE = process.argv[2] || 'bike';
const OUT = process.argv[3] || '/tmp/zz-dismount.png';
const { page, errs, close } = await boot();

await page.evaluate((r) => { const a = window.WALLY.ctx.game.actions; a.grantRide(r); a.equipRide(r); }, RIDE);
await page.waitForTimeout(2200);
await page.keyboard.down('KeyW'); await page.waitForTimeout(1600); await page.keyboard.up('KeyW');
await page.waitForTimeout(700);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(2500);

const out = await page.evaluate((r) => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const p = c.wally.rideProps[r];
  const g = p.group;
  g.updateMatrixWorld(true);
  const H = (x, z) => { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; };
  const wheels = p.wheels.map((w, i) => {
    const v = new T.Vector3(w.position.x, 0, 0);
    let z = 0;
    for (let n = w; n && n !== g; n = n.parent) { z += n.position.z; v.x += (n === w ? 0 : n.position.x); }
    v.z = z;
    v.applyMatrix4(g.matrixWorld);
    const h = H(v.x, v.z);
    return { i, errMM: h == null ? null : +((v.y - h) * 1000).toFixed(1) };
  });
  let st = null; g.traverse((o) => { if (o.name === 'kickstand') st = o; });
  let foot = null;
  if (st) {
    const pos = st.geometry.attributes.position, v = new T.Vector3();
    let lo = Infinity, bx = 0, bz = 0;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(st.matrixWorld);
      if (v.y < lo) { lo = v.y; bx = v.x; bz = v.z; }
    }
    const h = H(bx, bz);
    foot = h == null ? null : +((lo - h) * 1000).toFixed(1);
  }
  const res = { ride: r, at: g.position.toArray().map((v) => +v.toFixed(2)),
    order: g.rotation.order,
    pitchDeg: +(g.rotation.x * 180 / Math.PI).toFixed(2),
    rollDeg: +(g.rotation.z * 180 / Math.PI).toFixed(2),
    leanDeg: +(p.parkLean * 180 / Math.PI).toFixed(2),
    standVisible: st ? st.visible : null, visible: g.visible,
    onRoad: c.world.isRoad(g.position.x, g.position.z),
    wheels, standFootMM: foot };
  /* look at it from the stand side */
  const cam = c.camera;
  if (c.cam?.setEnabled) c.cam.setEnabled(false);
  c.wally.root.visible = false;
  const yaw = g.rotation.y;
  const lat = new T.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  cam.position.copy(g.position).addScaledVector(lat, 2.3).add(new T.Vector3(0, 0.85, 0));
  cam.lookAt(g.position.x, g.position.y + 0.40, g.position.z);
  cam.updateProjectionMatrix();
  return res;
}, RIDE);
console.log(JSON.stringify(out));
await page.waitForTimeout(400);
await page.screenshot({ path: OUT });
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
