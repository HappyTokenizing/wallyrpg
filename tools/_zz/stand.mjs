/* _zz/stand.mjs — the kickstand's own geometry, in the prop's frame.
   Axis endpoint vs lowest PAINTED vertex, and each one's height above
   the wheel-contact plane (group-local y=0) at the nominal park lean. */
import { boot } from '../_jj/lib.mjs';
const { page, errs, close } = await boot();
const out = await page.evaluate(() => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const res = [];
  const w = c.wally.root.position;
  for (const k of ['bike','scooter','motorcycle']) { try { W.debug.parkProbe(w.x, w.z, 0.37, k); } catch (e) {} }
  for (const key of ['bike', 'scooter', 'motorcycle']) {
    const p = c.wally.rideProps[key];
    if (!p) { res.push({ key, error: 'not built' }); continue; }
    const g = p.group;
    let m = null; g.traverse((o) => { if (o.name === 'kickstand') m = o; });
    if (!m) { res.push({ key, error: 'no kickstand' }); continue; }
    const lean = p.parkLean;
    /* vertices into the GROUP's frame: the mesh's own matrix only */
    m.updateMatrix();
    const pos = m.geometry.attributes.position;
    const v = new T.Vector3();
    let lo = null, loY = Infinity;
    const Y = (x, y) => x * Math.sin(lean) + y * Math.cos(lean);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrix);
      const yy = Y(v.x, v.y);
      if (yy < loY) { loY = yy; lo = v.clone(); }
    }
    const par = m.geometry.parameters;
    const tip = new T.Vector3(0, -(par.length * 0.5 + par.radius), 0).applyMatrix4(m.matrix);
    /* the analytic lowest point of the end cap, at this lean: the cap
       sphere centre, dropped by the radius along world -y */
    const ctr = new T.Vector3(0, -par.length * 0.5, 0).applyMatrix4(m.matrix);
    const cs = Math.cos(lean), sn = Math.sin(lean);
    const ctrY = Y(ctr.x, ctr.y);
    res.push({ key, leanRad: +lean.toFixed(4), leanDeg: +(lean * 180 / Math.PI).toFixed(2),
      radiusMM: +(par.radius * 1000).toFixed(1),
      tipLocal: [+tip.x.toFixed(4), +tip.y.toFixed(4), +tip.z.toFixed(4)],
      tipAboveContactPlaneMM: +(Y(tip.x, tip.y) * 1000).toFixed(1),
      paintedLocal: [+lo.x.toFixed(4), +lo.y.toFixed(4), +lo.z.toFixed(4)],
      paintedAboveContactPlaneMM: +(loY * 1000).toFixed(1),
      analyticCapBottomMM: +((ctrY - par.radius) * 1000).toFixed(1),
      vertices: pos.count });
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
