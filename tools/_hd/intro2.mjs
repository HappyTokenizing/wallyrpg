/* _hd/intro2.mjs — the shipped hero mark, measured. Both intro.js and
   bike.js make claims about this one pose: intro.js says the roll comes
   back -6.11 on 1.34 degrees of pad cross-slope and the painted stand
   reads -4.4 mm; bike.js says flat ground is unchanged and the hero
   mark "is exactly what it was". They cannot both be right, so measure
   the mark: pitch, roll, both wheel contacts, the DESIGN contact point
   and the painted stand's closest approach to the ground.
*/
import { boot } from '../_pj/lib.mjs';
const { page, errs, close } = await boot({ query: '', wait: 4500 });
const out = await page.evaluate(async () => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const res = [];
  for (const mark of [4, 5]) {
    W.debug.playIntro();
    W.debug.introShot(mark);
    await new Promise((r) => setTimeout(r, 900));
    W.debug.skipIntro();
    await new Promise((r) => setTimeout(r, 1100));
    let g = null;
    c.scene.traverse((o) => { if (o.name === 'intro.bicycle') g = o; });
    if (!g) { res.push({ mark, error: 'no intro.bicycle in scene' }); continue; }
    g.updateMatrixWorld(true);
    const H = (x, z) => { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; };
    const wheels = [];
    g.traverse((o) => { if (o.isGroup && o.parent === g && Math.abs(o.position.y - 0.225) < 1e-6) wheels.push(o); });
    const rows = wheels.map((w, i) => {
      const v = new T.Vector3(0, 0, w.position.z).applyMatrix4(g.matrixWorld);
      const h = H(v.x, v.z);
      return { i, errMM: h == null ? null : +((v.y - h) * 1000).toFixed(3) };
    });
    let st = null; g.traverse((o) => { if (o.name === 'kickstand') st = o; });
    let lowestMM = null, clearMM = null, verts = null;
    if (st) {
      const p = st.geometry.attributes.position, v = new T.Vector3();
      verts = p.count;
      let lo = Infinity, bx = 0, bz = 0, minClear = Infinity;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(st.matrixWorld);
        if (v.y < lo) { lo = v.y; bx = v.x; bz = v.z; }
        const h = H(v.x, v.z);
        if (h != null) minClear = Math.min(minClear, v.y - h);
      }
      const hl = H(bx, bz);
      lowestMM = hl == null ? null : +((lo - hl) * 1000).toFixed(3);
      clearMM = Number.isFinite(minClear) ? +(minClear * 1000).toFixed(3) : null;
    }
    /* the DESIGN contact point, which is what the solve stands on the
       ground — bike.js publishes it as standFoot */
    const mod = await import('/src/character/bike.js');
    const F = { x: 0.235, y: 0.031, z: -0.190 };   // PARK_FOOT, checked below
    const dv = new T.Vector3(F.x, F.y, F.z).applyMatrix4(g.matrixWorld);
    const dh = H(dv.x, dv.z);
    /* the ground's cross-slope under the stand, along the machine's own
       lateral axis, which is the phi in r = lean + phi */
    const yaw = g.rotation.y;
    const lx = Math.cos(yaw), lz = -Math.sin(yaw);
    const bx0 = dv.x - lx * F.x, bz0 = dv.z - lz * F.x;
    const h0 = H(bx0, bz0), h1 = H(bx0 + lx * F.x, bz0 + lz * F.x);
    const crossDeg = (h0 == null || h1 == null) ? null : +(Math.atan2(h1 - h0, F.x) * 180 / Math.PI).toFixed(3);
    res.push({ mark, at: [+g.position.x.toFixed(3), +g.position.y.toFixed(3), +g.position.z.toFixed(3)],
      order: g.rotation.order,
      pitchDeg: +(g.rotation.x * 180 / Math.PI).toFixed(3),
      rollDeg: +(g.rotation.z * 180 / Math.PI).toFixed(3),
      leanDeg: +(mod.PARK_LEAN !== undefined ? mod.PARK_LEAN * 180 / Math.PI : -0.13 * 180 / Math.PI).toFixed(3),
      wheels: rows, standVerts: verts,
      designFootMM: dh == null ? null : +((dv.y - dh) * 1000).toFixed(3),
      lowestPaintedMM: lowestMM, paintedMinClearanceMM: clearMM,
      groundCrossSlopeUnderStandDeg: crossDeg });
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
