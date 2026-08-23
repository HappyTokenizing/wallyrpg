/* THE CONFORM LADDER, on ground a player could actually be standing on.

   Part 1 repeats the census with a SMOOTHNESS filter: a site counts
   only if ctx.world.heightAt varies by less than SPREAD over the
   machine's own footprint, which is what separates a street or a
   hillside from a cliff lip or a building edge.

   Part 2 walks a ladder of gradients from 2 to 48 degrees, and at each
   rung parks all three machines through the real parkProbe and prints
   BOTH wheel clearances. */
import { boot, P } from './lib.mjs';
const SPREAD = +(process.argv[2] || 0.35);
const { page, errs, close } = await boot({ wait: 4500 });

await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  W.ctx.wally.setBike(true, { ride: 'bike', instant: true });
  const p = c.wally.rideProps.bike, g = p.group;
  const cz = (w) => { let z = 0; for (let n = w; n && n !== g; n = n.parent) z += n.position.z; return z; };
  const zf = cz(p.wheels[0]), zr = cz(p.wheels[1]);
  W.ctx.wally.setBike(false, { instant: true });
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  const CL = 0.838, cl = (v) => Math.max(-CL, Math.min(CL, v));
  window.__H = H;
  /* PLANARITY, not spread: fit a plane to the footprint by least
     squares and take the worst residual. A 45-degree hillside is
     perfectly parkable and has a huge spread; a 40 mm kerb is not, and
     has a small one. Filtering on spread would have thrown away every
     site above 13 degrees and called the result a census. */
  window.__PLANAR = (x, z, r) => {
    let n = 0, sx = 0, sz = 0, sh = 0, sxx = 0, szz = 0, sxz = 0, sxh = 0, szh = 0;
    const pts = [];
    for (let dx = -r; dx <= r + 1e-9; dx += r / 3) for (let dz = -r; dz <= r + 1e-9; dz += r / 3) {
      const h = H(x + dx, z + dz); if (h == null) return null;
      pts.push([dx, dz, h]);
      n++; sx += dx; sz += dz; sh += h; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; sxh += dx * h; szh += dz * h;
    }
    const mx = sx / n, mz = sz / n, mh = sh / n;
    const cxx = sxx - n * mx * mx, czz = szz - n * mz * mz, cxz = sxz - n * mx * mz;
    const cxh = sxh - n * mx * mh, czh = szh - n * mz * mh;
    const det = cxx * czz - cxz * cxz;
    if (Math.abs(det) < 1e-9) return null;
    const a = (cxh * czz - czh * cxz) / det, b = (czh * cxx - cxh * cxz) / det;
    let worst = 0;
    for (const [dx, dz, h] of pts) worst = Math.max(worst, Math.abs(h - (mh + a * (dx - mx) + b * (dz - mz))));
    return worst;
  };
  window.__SIM = (px, pz, yaw) => {
    const base = zf - zr, fx = Math.sin(yaw), fz = Math.cos(yaw);
    const gy0 = H(px, pz); if (gy0 == null) return null;
    const hf0 = H(px + fx * zf, pz + fz * zf) ?? gy0, hr0 = H(px + fx * zr, pz + fz * zr) ?? gy0;
    let raw = Math.atan2(hr0 - hf0, base), pitch = cl(raw), gy = (hf0 + hr0) * 0.5;
    const cf = Math.cos(pitch);
    const hf = H(px + fx * zf * cf, pz + fz * zf * cf), hr = H(px + fx * zr * cf, pz + fz * zr * cf);
    if (hf != null && hr != null) {
      raw = Math.asin(Math.max(-1, Math.min(1, (hr - hf) / base)));
      pitch = cl(raw); gy = (hf + hr) * 0.5 + (zf + zr) * 0.5 * Math.sin(pitch);
    }
    if (Math.abs(raw) > CL) {
      const s2 = Math.sin(pitch), c2 = Math.cos(pitch);
      const hf2 = H(px + fx * zf * c2, pz + fz * zf * c2) ?? hf0, hr2 = H(px + fx * zr * c2, pz + fz * zr * c2) ?? hr0;
      const sag = Math.min(gy - zf * s2 - hf2, gy - zr * s2 - hr2);
      if (Number.isFinite(sag) && sag < 0) gy -= sag;
    }
    const s = Math.sin(pitch), c3 = Math.cos(pitch);
    const mm = [zf, zr].map((z) => {
      const h = H(px + fx * z * c3, pz + fz * z * c3);
      return h == null ? null : +(((gy - z * s) - h) * 1000).toFixed(1);
    });
    return { deg: +(raw * 180 / Math.PI).toFixed(3), clamped: Math.abs(raw) > CL, mm };
  };
});

/* ---- part 1: the smooth-ground census ---- */
const cen = await page.evaluate((spread) => {
  const H = window.__H;
  const buckets = {}; let n = 0, rejected = 0;
  for (let x = -900; x <= 900; x += 7) {
    for (let z = -900; z <= 900; z += 7) {
      const h = H(x, z); if (h == null || h < 0.4) continue;
      const sp = window.__PLANAR(x, z, 0.9);
      if (sp == null || sp > spread) { rejected++; continue; }
      for (let a = 0; a < 8; a++) {
        const yaw = (a / 8) * Math.PI * 2;
        const px = x + Math.cos(yaw) * -0.62, pz = z - Math.sin(yaw) * -0.62;
        const r = window.__SIM(px, pz, yaw);
        if (!r || r.mm.some((v) => v == null)) continue;
        n++;
        const k = Math.min(60, Math.floor(Math.abs(r.deg)));
        const w = Math.max(Math.abs(r.mm[0]), Math.abs(r.mm[1]));
        const b = buckets[k] || (buckets[k] = { n: 0, worst: 0, over1: 0, over10: 0, buried: 0, at: null });
        b.n++;
        if (w > b.worst) { b.worst = w; b.at = [x, z, +yaw.toFixed(3), r.deg, r.mm[0], r.mm[1]]; }
        if (w > 1) b.over1++;
        if (w > 10) b.over10++;
        if (Math.min(r.mm[0], r.mm[1]) < -1) b.buried++;
      }
    }
  }
  return { n, rejected, buckets };
}, SPREAD);
P('PLANAR-CENSUS', { spread: SPREAD, n: cen.n, rejectedSites: cen.rejected });
for (const k of Object.keys(cen.buckets).map(Number).sort((a, b) => a - b)) P('SBUCKET' + String(k).padStart(3), cen.buckets[k]);

/* ---- part 2: the ladder, all three machines, real parkProbe ---- */
const picks = await page.evaluate((spread) => {
  const H = window.__H;
  const want = [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35, 38, 40, 42, 44, 45, 46, 47, 47.9, 48.5, 52];
  const found = {};
  for (let x = -900; x <= 900; x += 7) {
    for (let z = -900; z <= 900; z += 7) {
      const h = H(x, z); if (h == null || h < 0.4) continue;
      const sp = window.__PLANAR(x, z, 0.9);
      if (sp == null || sp > spread) continue;
      for (let a = 0; a < 8; a++) {
        const yaw = (a / 8) * Math.PI * 2;
        const px = x + Math.cos(yaw) * -0.62, pz = z - Math.sin(yaw) * -0.62;
        const r = window.__SIM(px, pz, yaw);
        if (!r) continue;
        for (const t of want) {
          const d = Math.abs(Math.abs(r.deg) - t);
          if (!found[t] || d < found[t].miss) found[t] = { miss: d, x, z, yaw: +yaw.toFixed(4), deg: r.deg, spread: +sp.toFixed(3) };
        }
      }
    }
  }
  return found;
}, SPREAD);

for (const t of Object.keys(picks).map(Number).sort((a, b) => a - b)) {
  const s = picks[t];
  if (s.miss > 0.5) { P('RUNG', { want: t, skipped: true, closest: s.deg }); continue; }
  const out = { want: t, site: [s.x, s.z, s.yaw], planarM: s.spread };
  for (const ride of ['bike', 'scooter', 'motorcycle']) {
    const r = await page.evaluate(([q, rd]) => window.WALLY.debug.parkProbe(q.x, q.z, q.yaw, rd), [s, ride]);
    out[ride] = { deg: r.gradientDeg, clamped: r.clamped, mm: (r.wheels || []).map((w) => w.errMM) };
    await page.evaluate(() => { window.WALLY.ctx.wally.setBike(false, { instant: true }); });
  }
  P('RUNG', out);
}
P('ERRS', errs.slice(0, 8));
await close();
