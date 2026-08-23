/* _zz/intro.mjs — the opener's own park solve, through the shared one.
   Seeks to the ride mark, skips, and measures the arrival bicycle: both
   wheel contacts and the kickstand foot, against the STAGE's ground
   (board.groundY), which is what parkArrival solves against.
*/
import { boot } from '../_jj/lib.mjs';
const { page, errs, close } = await boot({ query: '', wait: 4000 });
const out = await page.evaluate(async () => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const res = [];
  for (const mark of [4, 5]) {
    W.debug.playIntro();
    W.debug.introShot(mark);
    await new Promise((r) => setTimeout(r, 900));
    W.debug.skipIntro();
    await new Promise((r) => setTimeout(r, 900));
    /* find the arrival bicycle in the scene by name */
    let g = null;
    c.scene.traverse((o) => { if (o.name === 'intro.bicycle') g = o; });
    if (!g) { res.push({ mark, error: 'no intro.bicycle in scene' }); continue; }
    g.updateMatrixWorld(true);
    const H = (x, z) => { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; };
    /* the wheels, as the point under each axle in the prop's frame */
    const wheels = [];
    g.traverse((o) => { if (o.isGroup && o.parent === g && Math.abs(o.position.y - 0.225) < 1e-6) wheels.push(o); });
    const rows = wheels.map((w, i) => {
      const v = new T.Vector3(0, 0, w.position.z).applyMatrix4(g.matrixWorld);
      const h = H(v.x, v.z);
      return { i, errMM: h == null ? null : +((v.y - h) * 1000).toFixed(1) };
    });
    let st = null;
    g.traverse((o) => { if (o.name === 'kickstand') st = o; });
    let footMM = null, standVisible = null;
    if (st) {
      standVisible = st.visible;
      const p = st.geometry.attributes.position, v = new T.Vector3();
      let lo = Infinity, bx = 0, bz = 0;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(st.matrixWorld);
        if (v.y < lo) { lo = v.y; bx = v.x; bz = v.z; }
      }
      const h = H(bx, bz);
      footMM = h == null ? null : +((lo - h) * 1000).toFixed(1);
    }
    res.push({ mark, at: g.position.toArray().map((v) => +v.toFixed(2)),
      order: g.rotation.order,
      pitchDeg: +(g.rotation.x * 180 / Math.PI).toFixed(2),
      rollDeg: +(g.rotation.z * 180 / Math.PI).toFixed(2),
      wheels: rows, standVisible, standFootMM: footMM });
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 6));
await close();
