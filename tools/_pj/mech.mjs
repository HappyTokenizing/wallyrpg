/* _pj/mech.mjs — WHY the lattice hides it. For a sample of sites,
   print pass-one pitch, pass-two pitch, the reach change each wheel
   sees, and whether THAT segment (not the wheel-to-wheel span) crosses
   a terrain triangle edge. The header blames wheel-to-wheel straddle;
   the closed form blames the per-wheel reach segment. */
import { boot } from './lib.mjs';
const MODE = process.argv[2] || 'lat';
const { page, close } = await boot();
const o = await page.evaluate((mode) => {
  const W = window.WALLY, c = W.ctx, T = W.THREE;
  const CELL = 2, gx0 = -672, gz0 = -560;
  const H = (x, z) => { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : NaN; };
  const tri = (x, z) => { const gx = (x - gx0) / CELL, gz = (z - gz0) / CELL;
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    return i + ',' + j + ',' + (fz <= fx ? 0 : 1); };
  const cl = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const PM = 0.838;
  const LAT = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
  const GOLD = 2.399963229728653;
  const step = mode === 'lat' ? 10 : 7.3, off = mode === 'lat' ? 0 : 0.37;
  const b = c.world.bounds;
  let n = 0, wheelStraddle = 0, wheelSame = 0, p1eqp2 = 0, reachMoved = 0, k = 0;
  let maxDP = 0, maxReach = 0; const rows = [];
  let axisAligned = 0, sameFxPair = 0, pairStraddle = 0;
  for (let x = b.min.x + off; x <= b.max.x; x += step) {
    for (let z = b.min.z + off * 1.7; z <= b.max.z; z += step) {
      const h0 = H(x, z); if (!Number.isFinite(h0) || h0 < c.world.seaLevel + 0.15) continue;
      const yaw = mode === 'lat' ? LAT[k % 4] : (k * GOLD) % (Math.PI * 2); k++;
      const p = W.debug.parkProbe(x, z, yaw, 'bike', true);
      if (p.error) continue;
      const pr = c.wally.rideProps[p.ride]; const g = pr.group;
      const px = g.position.x, pz = g.position.z;
      const ws = pr.wheels;
      const lz = (w) => { let s = 0; for (let q = w; q && q !== g; q = q.parent) s += q.position.z; return s; };
      const zf = lz(ws[0]), zr = lz(ws[1]), base = zf - zr;
      const fxw = Math.sin(yaw), fzw = Math.cos(yaw);
      const imp = (pp) => { const cp = Math.cos(pp);
        const hf = H(px + fxw * zf * cp, pz + fzw * zf * cp);
        const hr = H(px + fxw * zr * cp, pz + fzw * zr * cp);
        return { v: Math.asin(cl((hr - hf) / base, -1, 1)), hf, hr }; };
      const s0 = imp(0);
      const p1 = cl(Math.atan2(s0.hr - s0.hf, base), -PM, PM);
      const s1 = imp(p1);
      const p2 = cl(s1.v, -PM, PM);
      if (p.clamped) continue;
      n++;
      const dp = Math.abs(p2 - p1); maxDP = Math.max(maxDP, dp);
      if (dp < 1e-12) p1eqp2++;
      for (const zz of [zf, zr]) {
        const a = { x: px + fxw * zz * Math.cos(p1), z: pz + fzw * zz * Math.cos(p1) };
        const bb = { x: px + fxw * zz * Math.cos(p2), z: pz + fzw * zz * Math.cos(p2) };
        const d = Math.hypot(a.x - bb.x, a.z - bb.z); maxReach = Math.max(maxReach, d);
        if (d > 1e-9) reachMoved++;
        if (tri(a.x, a.z) === tri(bb.x, bb.z)) wheelSame++; else wheelStraddle++;
      }
      /* the wheel-to-wheel pair, at the FINAL pitch */
      const A = { x: px + fxw * zf * Math.cos(p2), z: pz + fzw * zf * Math.cos(p2) };
      const B = { x: px + fxw * zr * Math.cos(p2), z: pz + fzw * zr * Math.cos(p2) };
      if (tri(A.x, A.z) !== tri(B.x, B.z)) pairStraddle++;
      if (Math.abs(fxw) < 1e-9 || Math.abs(fzw) < 1e-9) axisAligned++;
      if (rows.length < 8 && dp > 1e-6) rows.push({ x: +x.toFixed(2), z: +z.toFixed(2), yaw: +yaw.toFixed(3),
        p1deg: +(p1 * 180 / Math.PI).toFixed(3), p2deg: +(p2 * 180 / Math.PI).toFixed(3),
        reachDeltaMM: +((zf * (Math.cos(p1) - Math.cos(p2))) * 1000).toFixed(2) });
    }
  }
  return { mode, sites: n, axisAlignedSites: axisAligned,
    pitchIdenticalP1P2: p1eqp2, maxAbsP1P2Deg: +(maxDP * 180 / Math.PI).toFixed(6),
    contactsWhoseReachMoved: reachMoved, maxReachMoveM: +maxReach.toFixed(4),
    perWheelReachSegmentStraddles: wheelStraddle, perWheelReachSameTriangle: wheelSame,
    wheelToWheelPairStraddles: pairStraddle, sample: rows };
}, MODE);
console.log(JSON.stringify(o, null, 1));
await close();
