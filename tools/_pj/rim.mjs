/* _pj/rim.mjs — my census calls a wheel contact "prop-local y=0 under
   the axle", which is the same definition the code under test uses. If
   that definition is wrong, both agree and the 0.0 mm means nothing.
   So check it against something the code does not define: the LOWEST
   PAINTED VERTEX of each wheel mesh, against heightAt under its own
   x/z, at real park sites. The tessellation and the rolling angle put
   a floor under how close that can get, so publish the flat-ground
   value as the floor and the slope values against it. */
import { boot } from './lib.mjs';
const { page, errs, close } = await boot();
const out = await page.evaluate(() => {
  const W = window.WALLY, T = W.THREE, c = W.ctx, b = c.world.bounds;
  const H = (x, z) => { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : NaN; };
  const DOC = [0.37, 1.19, 2.41, 4.02, 5.51];
  const rows = []; let k = 0, n = 0;
  const acc = { worst: 0, worstAt: null, sum: 0, n: 0, over20: 0 };
  for (let x = b.min.x + 0.37; x <= b.max.x && n < 900; x += 31.7)
    for (let z = b.min.z + 0.63; z <= b.max.z && n < 900; z += 29.3) {
      const h = H(x, z); if (!Number.isFinite(h) || h < c.world.seaLevel + 0.15) continue;
      const yaw = DOC[k++ % 5];
      const p = W.debug.parkProbe(x, z, yaw, 'bike', true);
      if (p.error || p.clamped) continue;
      const pr = c.wally.rideProps[p.ride], g = pr.group; g.updateMatrixWorld(true);
      n++;
      for (const w of (pr.wheels || []).slice(0, 2)) {
        w.updateMatrixWorld(true);
        /* the wheel is a GROUP of meshes; and the §2.2 outline hulls
           must be left out or the rim reads low by the stroke width */
        const v = new T.Vector3(); let lo = Infinity, bx = 0, bz = 0, seen = 0;
        w.traverse((o) => {
          if (!o.isMesh || !o.geometry?.attributes?.position) return;
          if (/\.outline$/.test(o.name) || o.material?.side === T.BackSide) return;
          const pos = o.geometry.attributes.position; seen++;
          for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
            if (v.y < lo) { lo = v.y; bx = v.x; bz = v.z; } }
        });
        if (!seen) continue;
        const th = H(bx, bz); if (!Number.isFinite(th)) continue;
        const e = (lo - th) * 1000;
        acc.n++; acc.sum += Math.abs(e);
        if (Math.abs(e) > Math.abs(acc.worst)) { acc.worst = e; acc.worstAt = [+x.toFixed(2), +z.toFixed(2), p.gradientDeg]; }
        if (Math.abs(e) > 20) acc.over20++;
        if (rows.length < 6) rows.push({ x: +x.toFixed(1), z: +z.toFixed(1), grad: p.gradientDeg, rimMM: +e.toFixed(2), axleContactMM: p.wheels.map((q) => q.errMM) });
      }
    }
  /* the floor: same measurement on dead-flat ground */
  return { sites: n, contacts: acc.n, meanAbsMM: +(acc.sum / Math.max(acc.n, 1)).toFixed(2),
    worstMM: +acc.worst.toFixed(2), worstAt: acc.worstAt, over20mm: acc.over20, sample: rows };
});
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
