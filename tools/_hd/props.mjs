/* _hd/props.mjs — the per-prop numbers the park header quotes and the
   apparent-height column depends on, all in the prop's OWN frame at its
   OWN lean, with no terrain in the way:

     - the design contact point's height at the lean (must be 0: each
       prop places its foot on its own contact plane, y = -x tan lean)
     - the LOWEST PAINTED vertex of the stand below that plane, which is
       the offset the header quotes as 4.4 / 5.6 / 5.1
     - the extra roll that would be needed to stand the painted vertex
       on the plane instead — the header's "1.1 degrees more upright"
     - painted bounding height, upright and parked, for the thin lens
*/
import { boot } from '../_pj/lib.mjs';
const { page, errs, close } = await boot();
const out = await page.evaluate(async () => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const isHull = (o) => /\.outline$/.test(o.name) || (o.material && o.material.side === T.BackSide);
  const bike = await import('/src/character/bike.js');
  const rides = await import('/src/character/rides.js');
  const made = [];
  made.push(['bicycle', bike.createBike(c)]);
  made.push(['scooter', rides.createScooter(c)]);
  made.push(['motorcycle', rides.createMotorcycle(c)]);
  const rows = [];
  for (const [name, p] of made) {
    if (!p) { rows.push({ ride: name, error: 'not built' }); continue; }
    const g = p.group;
    c.scene.add(g);
    const lean = p.parkLean, F = p.standFoot;
    /* --- at the lean, origin at 0, no pitch, no yaw --- */
    p.park(true);
    g.position.set(0, 0, 0);
    g.rotation.order = 'YXZ';
    g.rotation.set(0, 0, lean);
    g.updateMatrixWorld(true);
    let km = null; g.traverse((o) => { if (o.name === 'kickstand') km = o; });
    const v = new T.Vector3();
    const designY = new T.Vector3(F.x, F.y, F.z).applyMatrix4(g.matrixWorld).y;
    let lowY = Infinity, lowX = 0, lowLocal = null;
    if (km) { const pos = km.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(km.matrixWorld);
        if (v.y < lowY) { lowY = v.y; lowX = v.x;
          lowLocal = new T.Vector3().fromBufferAttribute(pos, i).applyMatrix4(km.matrixWorld); } } }
    /* the same vertex in the prop's UNROLLED frame, so the extra roll
       that would put it on the plane can be solved for exactly:
       x sin r + y cos r = 0  ->  r = -atan2(y, x) ... take the root
       nearest the lean */
    let extraRollDeg = null, vertLocal = null;
    if (lowLocal) {
      const cr = Math.cos(lean), sr = Math.sin(lean);
      const x0 = lowLocal.x * cr + lowLocal.y * sr;
      const y0 = -lowLocal.x * sr + lowLocal.y * cr;
      vertLocal = { x: +x0.toFixed(5), y: +y0.toFixed(5) };
      const r = Math.atan2(-y0, x0);
      const pick = [r, r + Math.PI, r - Math.PI].sort((a, b) => Math.abs(a - lean) - Math.abs(b - lean))[0];
      extraRollDeg = +((pick - lean) * 180 / Math.PI).toFixed(3);
    }
    const bb = (rot) => { g.rotation.set(0, 0, rot); g.updateMatrixWorld(true);
      const box = new T.Box3(); box.makeEmpty(); const q = new T.Vector3();
      g.traverse((o) => { if (!o.isMesh || isHull(o) || !o.geometry?.attributes?.position) return;
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) box.expandByPoint(q.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld)); });
      return { h: +(box.max.y - box.min.y).toFixed(4), min: +box.min.y.toFixed(4), max: +box.max.y.toFixed(4) }; };
    const parked = bb(lean);
    p.park(false);
    const upright = bb(0);
    rows.push({ ride: name, leanDeg: +(lean * 180 / Math.PI).toFixed(4),
      foot: F, designContactY_mm: +(designY * 1000).toFixed(4),
      lowestPaintedBelowPlane_mm: +(-lowY * 1000).toFixed(3), lowestPaintedX: +lowX.toFixed(4),
      lowestVertexInUnrolledFrame: vertLocal, extraRollToStandOnPaint_deg: extraRollDeg,
      kickstandVerts: km ? km.geometry.attributes.position.count : null,
      paintedParked: parked, paintedUpright: upright });
    c.scene.remove(g); p.dispose && p.dispose();
  }
  return rows;
});
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
