/* _pj/dismount.mjs — REAL gameplay dismounts at many spots. Teleports,
   grants + equips through ctx.game.actions, rides on a real key press,
   unequips through the same actions, then measures the machine left
   behind: both wheel contacts and the kickstand's LOWEST PAINTED
   VERTEX, against ctx.world.heightAt under its own x/z. Also reports
   what the pose WOULD have been at the constant lean, from the same
   frame, so before/after come off one dismount.
   node tools/_pj/dismount.mjs <ride> <n>
*/
import { boot } from './lib.mjs';
const RIDE = process.argv[2] || 'bike';
const N = +(process.argv[3] || 12);
const { page, errs, close } = await boot();

const spots = await page.evaluate((n) => {
  const c = window.WALLY.ctx, b = c.world.bounds;
  const road = [], land = [];
  let k = 0;
  for (let x = b.min.x + 3.7; x <= b.max.x; x += 11.3)
    for (let z = b.min.z + 5.1; z <= b.max.z; z += 13.7) {
      const h = c.world.heightAt(x, z);
      if (!Number.isFinite(h) || h < c.world.seaLevel + 0.3) continue;
      const g = Math.abs(c.world.heightAt(x + 1, z) - c.world.heightAt(x - 1, z)) / 2;
      const rec = { x: +x.toFixed(2), z: +z.toFixed(2), y: h, gradient: +g.toFixed(3) };
      if (c.world.isRoad(x, z)) road.push(rec); else if (g > 0.05) land.push(rec);
      k++;
    }
  const pick = (a, m) => { const o = []; for (let i = 0; i < m && a.length; i++) o.push(a[Math.floor(i * a.length / m)]); return o; };
  return pick(road, Math.ceil(n / 2)).concat(pick(land, Math.floor(n / 2)));
}, N);

const rows = [];
for (const s of spots) {
  await page.evaluate(([sp, r]) => {
    const W = window.WALLY, c = W.ctx;
    c.game.actions.equipRide(null);
    W.debug.physTeleport(sp.x, sp.y + 0.6, sp.z);
    c.wally.setPosition(sp.x, sp.y, sp.z);
    c.game.actions.grantRide(r); c.game.actions.equipRide(r);
  }, [s, RIDE]);
  await page.waitForTimeout(1600);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(900); await page.keyboard.up('KeyW');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
  await page.waitForTimeout(2200);
  const r = await page.evaluate((rd) => {
    const W = window.WALLY, T = W.THREE, c = W.ctx;
    const p = c.wally.rideProps[rd]; if (!p) return { error: 'no prop' };
    const g = p.group; g.updateMatrixWorld(true);
    const H = (x, z) => { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; };
    const wheels = (p.wheels || []).slice(0, 2).map((w, i) => {
      let x = 0, z = 0; for (let n = w; n && n !== g; n = n.parent) { x += n.position.x; z += n.position.z; }
      const v = new T.Vector3(x, 0, z).applyMatrix4(g.matrixWorld);
      const h = H(v.x, v.z); return h == null ? null : +((v.y - h) * 1000).toFixed(1);
    });
    let st = null; g.traverse((o) => { if (o.name === 'kickstand') st = o; });
    const footOf = (obj) => {
      if (!st) return null;
      st.updateMatrixWorld(true);
      const pos = st.geometry.attributes.position, v = new T.Vector3();
      let lo = Infinity, bx = 0, bz = 0;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        if (obj) { v.applyMatrix4(st.matrixWorld); } else v.applyMatrix4(st.matrixWorld);
        if (v.y < lo) { lo = v.y; bx = v.x; bz = v.z; }
      }
      const h = H(bx, bz); return h == null ? null : +((lo - h) * 1000).toFixed(1);
    };
    /* what the SAME dismount would read at the constant lean: put the
       group back to rotation.z = parkLean for one measurement, then
       restore. Nothing else about the pose changes. */
    const keepZ = g.rotation.z;
    const paintedNow = footOf(true);
    let designNow = null;
    if (p.standFoot) { const v = new T.Vector3(p.standFoot.x, p.standFoot.y, p.standFoot.z).applyMatrix4(g.matrixWorld);
      const h = H(v.x, v.z); designNow = h == null ? null : +((v.y - h) * 1000).toFixed(1); }
    g.rotation.z = p.parkLean; g.updateMatrixWorld(true);
    const paintedConst = footOf(true);
    let designConst = null;
    if (p.standFoot) { const v = new T.Vector3(p.standFoot.x, p.standFoot.y, p.standFoot.z).applyMatrix4(g.matrixWorld);
      const h = H(v.x, v.z); designConst = h == null ? null : +((v.y - h) * 1000).toFixed(1); }
    g.rotation.z = keepZ; g.updateMatrixWorld(true);
    return { at: [+g.position.x.toFixed(2), +g.position.z.toFixed(2)],
      onRoad: !!c.world.isRoad(g.position.x, g.position.z),
      order: g.rotation.order,
      pitchDeg: +(g.rotation.x * 180 / Math.PI).toFixed(2),
      rollDeg: +(g.rotation.z * 180 / Math.PI).toFixed(2),
      leanDeg: +(p.parkLean * 180 / Math.PI).toFixed(2),
      standVisible: st ? st.visible : null, propVisible: g.visible,
      wheelsMM: wheels, standPaintedMM: paintedNow, standDesignMM: designNow,
      constLeanPaintedMM: paintedConst, constLeanDesignMM: designConst };
  }, RIDE);
  rows.push(Object.assign({ spot: [s.x, s.z], grad: s.gradient }, r));
  console.log(JSON.stringify(rows[rows.length - 1]));
}
const num = (k) => rows.map((r) => r[k]).filter((v) => typeof v === 'number');
const S = (a) => a.length ? { n: a.length, mean: +(a.reduce((s, v) => s + Math.abs(v), 0) / a.length).toFixed(1),
  min: Math.min(...a), max: Math.max(...a), over20: a.filter((v) => v > 20).length } : null;
console.log('SUMMARY ' + JSON.stringify({ ride: RIDE, dismounts: rows.length,
  wheelsWorstMM: Math.max(...rows.flatMap((r) => (r.wheelsMM || []).map(Math.abs)).filter(Number.isFinite)),
  standPainted: S(num('standPaintedMM')), standDesign: S(num('standDesignMM')),
  constLeanPainted: S(num('constLeanPaintedMM')), constLeanDesign: S(num('constLeanDesignMM')),
  standAlwaysVisible: rows.every((r) => r.standVisible === true),
  rollOrderAlwaysYXZ: rows.every((r) => r.order === 'YXZ') }));
if (errs.length) console.log('ERRS', errs.slice(0, 5));
await close();
