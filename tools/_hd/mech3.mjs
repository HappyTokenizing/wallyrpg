/* _hd/mech3.mjs — WHAT actually made the on-lattice census read zero.
   The header blames "both wheel contacts inside the same triangle";
   _pj/mech.mjs already showed that is 0% true and that p1 == p2 to the
   bit anyway. This tool tests the two ingredients of the real
   mechanism, so the replacement sentence is measured and not argued:

     1. the machine origin lands EXACTLY on a terrain grid line normal
        to the heading (offset from the line, in cells, is 0), and
     2. the height profile along the heading is exactly LINEAR on each
        side of that origin over the whole reach — i.e. positively
        homogeneous about the origin, H(t*u) - h0 == t*(H(u) - h0).

   Given both, contracting both reaches by cos(p) scales the chord's
   rise by exactly cos(p), so pass two hands back pass one's own pitch
   and the residual H(z cos p1) - H(z cos p2) is identically zero.

   node tools/_hd/mech3.mjs [lat|off]
*/
import { boot } from '../_pj/lib.mjs';
const MODE = process.argv[2] || 'lat';
const { page, errs, close } = await boot();
const o = await page.evaluate((mode) => {
  const W = window.WALLY, c = W.ctx;
  const b = c.world.bounds;
  const CELL = c.world.cellSize;
  const gx0 = b.min.x, gz0 = b.min.z;
  const H = (x, z) => { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : NaN; };
  const tri = (x, z) => { const gx = (x - gx0) / CELL, gz = (z - gz0) / CELL;
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    return i + ',' + j + ',' + (fz <= fx ? 0 : 1); };
  /* the grid model, checked against heightAt itself: rebuild the
     interpolation from the four corner heights and compare. If gx0/gz0/
     CELL or the diagonal convention were wrong this blows up. */
  let gridResid = 0;
  for (let k = 0; k < 400; k++) {
    const x = b.min.x + (k * 37.13) % (b.max.x - b.min.x);
    const z = b.min.z + (k * 53.71) % (b.max.z - b.min.z);
    const gx = (x - gx0) / CELL, gz = (z - gz0) / CELL;
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    const X = (n) => gx0 + n * CELL, Z = (n) => gz0 + n * CELL;
    const h00 = H(X(i), Z(j)), h10 = H(X(i + 1), Z(j)), h01 = H(X(i), Z(j + 1)), h11 = H(X(i + 1), Z(j + 1));
    const model = fz <= fx ? h00 + (h10 - h00) * fx + (h11 - h10) * fz
                           : h00 + (h11 - h01) * fx + (h01 - h00) * fz;
    const real = H(x, z);
    if (Number.isFinite(model) && Number.isFinite(real)) gridResid = Math.max(gridResid, Math.abs(model - real));
  }

  const cl = (v, a, d) => (v < a ? a : (v > d ? d : v));
  const PM = 0.838;
  const LAT = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
  const GOLD = 2.399963229728653;
  const step = mode === 'lat' ? 10 : 7.3, off = mode === 'lat' ? 0 : 0.37;

  let n = 0, k = 0, onGridLine = 0, homog = 0, reachSameTri = 0, reachContacts = 0;
  let maxFrac = 0, maxHomogMM = 0, maxResidMM = 0, offsetSpread = { min: 1e9, max: -1e9 };
  const rows = [];
  for (let x = b.min.x + off; x <= b.max.x; x += step) {
    for (let z = b.min.z + off * 1.7; z <= b.max.z; z += step) {
      const h0g = H(x, z); if (!Number.isFinite(h0g) || h0g < c.world.seaLevel + 0.15) continue;
      const yaw = mode === 'lat' ? LAT[k % 4] : (k * GOLD) % (Math.PI * 2); k++;
      const p = W.debug.parkProbe(x, z, yaw, 'bike', true);
      if (p.error || p.clamped) continue;
      const pr = c.wally.rideProps[p.ride], g = pr.group;
      const px = g.position.x, pz = g.position.z;
      const lz = (w) => { let s = 0; for (let q = w; q && q !== g; q = q.parent) s += q.position.z; return s; };
      const zf = lz(pr.wheels[0]), zr = lz(pr.wheels[1]), base = zf - zr;
      const fxw = Math.sin(yaw), fzw = Math.cos(yaw);
      n++;
      offsetSpread.min = Math.min(offsetSpread.min, p.offsetX); offsetSpread.max = Math.max(offsetSpread.max, p.offsetX);

      /* 1. how far the origin sits from the grid line normal to the
         heading, in cells. Exactly 0 means the profile's breakpoint is
         under the machine. */
      const along = Math.abs(fzw) > Math.abs(fxw) ? (pz - gz0) / CELL : (px - gx0) / CELL;
      const frac = Math.abs(along - Math.round(along));
      if (frac < 1e-9) onGridLine++;
      maxFrac = Math.max(maxFrac, frac);

      /* 2. homogeneity of the profile about the origin, over the reach */
      const h0 = H(px, pz);
      const lin = (u) => H(px + fxw * u, pz + fzw * u) - h0;
      let worst = 0;
      for (const zz of [zf, zr]) {
        const full = lin(zz);
        for (const t of [0.2, 0.45, 0.7, 0.9]) worst = Math.max(worst, Math.abs(lin(zz * t) - t * full));
      }
      if (worst < 1e-12) homog++;
      maxHomogMM = Math.max(maxHomogMM, worst * 1000);

      /* 3. the header's own claim, made testable: does each wheel's
         reach segment — from the pass-one sample at full reach to the
         landing at cos(p1) — stay inside one triangle? Sampled along,
         not just at the ends. */
      const hf0 = H(px + fxw * zf, pz + fzw * zf), hr0 = H(px + fxw * zr, pz + fzw * zr);
      const p1 = cl(Math.atan2(hr0 - hf0, base), -PM, PM);
      const c1 = Math.cos(p1);
      for (const zz of [zf, zr]) {
        reachContacts++;
        let same = true; const t0 = tri(px + fxw * zz, pz + fzw * zz);
        for (let s = 1; s <= 6; s++) { const u = zz * (1 + (c1 - 1) * s / 6);
          if (tri(px + fxw * u, pz + fzw * u) !== t0) { same = false; break; } }
        if (same) reachSameTri++;
      }
      /* 4. the residual the two-pass solve actually leaves */
      const hf1 = H(px + fxw * zf * c1, pz + fzw * zf * c1), hr1 = H(px + fxw * zr * c1, pz + fzw * zr * c1);
      const p2 = cl(Math.asin(cl((hr1 - hf1) / base, -1, 1)), -PM, PM);
      const c2 = Math.cos(p2);
      const y = (hf1 + hr1) * 0.5 + (zf + zr) * 0.5 * Math.sin(p2);
      const ef = y - zf * Math.sin(p2) - H(px + fxw * zf * c2, pz + fzw * zf * c2);
      const er = y - zr * Math.sin(p2) - H(px + fxw * zr * c2, pz + fzw * zr * c2);
      maxResidMM = Math.max(maxResidMM, Math.abs(ef) * 1000, Math.abs(er) * 1000);
      if (rows.length < 5 && frac > 1e-9 && worst > 1e-9)
        rows.push({ x: +px.toFixed(3), z: +pz.toFixed(3), yaw: +yaw.toFixed(3),
          cellFrac: +frac.toFixed(4), homogErrMM: +(worst * 1000).toFixed(3),
          p1deg: +(p1 * 180 / Math.PI).toFixed(3), p2deg: +(p2 * 180 / Math.PI).toFixed(3),
          residMM: [+(ef * 1000).toFixed(2), +(er * 1000).toFixed(2)] });
    }
  }
  return { mode, step, off, gridModelMaxResidM: gridResid, sites: n, parkOffsetX: offsetSpread,
    originOnGridLine: onGridLine, originOnGridLinePct: +(100 * onGridLine / Math.max(n, 1)).toFixed(2),
    maxOriginOffsetCells: +maxFrac.toFixed(6),
    profileHomogeneousSites: homog, profileHomogeneousPct: +(100 * homog / Math.max(n, 1)).toFixed(2),
    maxHomogeneityErrMM: +maxHomogMM.toFixed(4),
    reachSegmentSameTriangle: reachSameTri, reachContacts,
    reachSameTrianglePct: +(100 * reachSameTri / Math.max(reachContacts, 1)).toFixed(2),
    twoPassMaxResidualMM: +maxResidMM.toFixed(3), sample: rows };
}, MODE);
console.log(JSON.stringify(o, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
