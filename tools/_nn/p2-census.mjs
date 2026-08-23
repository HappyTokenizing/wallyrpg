/* A CENSUS OF THE CONFORM ACROSS THE WHOLE CLAMP RANGE.

   parkProp's arithmetic is reproduced here from scratch (two passes,
   the clamp, the saturation lift) and the two contact residuals are
   computed from ctx.world.heightAt at the rotated reach. The
   reproduction is VALIDATED FIRST against the real parkProbe on 35
   sites — if the simulation and the game disagree anywhere, the census
   is thrown away rather than published.
   node tools/_nn/p2-census.mjs [ride] */
import { boot, P } from './lib.mjs';
import { readFile } from 'node:fs/promises';
const RIDE = process.argv[2] || 'bike';
const SITES = JSON.parse(await readFile(new URL('./sites.json', import.meta.url), 'utf8'));
const { page, errs, close } = await boot({ wait: 4000 });

await page.evaluate((ride) => {
  const W = window.WALLY, c = W.ctx;
  W.ctx.wally.setBike(true, { ride, instant: true });
  const p = W.ctx.wally.rideProps[ride], g = p.group;
  const cz = (w) => { let z = 0; for (let n = w; n && n !== g; n = n.parent) z += n.position.z; return z; };
  const zf = cz(p.wheels[0]), zr = cz(p.wheels[1]);
  W.ctx.wally.setBike(false, { instant: true });
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  const CL = 0.838, cl = (v) => Math.max(-CL, Math.min(CL, v));
  /* parkProp(), reproduced */
  window.__SIM = (px, pz, yaw) => {
    const base = zf - zr, fx = Math.sin(yaw), fz = Math.cos(yaw);
    const gy0 = H(px, pz); if (gy0 == null) return null;
    const hf0 = H(px + fx * zf, pz + fz * zf) ?? gy0, hr0 = H(px + fx * zr, pz + fz * zr) ?? gy0;
    let raw = Math.atan2(hr0 - hf0, base), pitch = cl(raw), gy = (hf0 + hr0) * 0.5;
    const cf = Math.cos(pitch);
    const hf = H(px + fx * zf * cf, pz + fz * zf * cf), hr = H(px + fx * zr * cf, pz + fz * zr * cf);
    if (hf != null && hr != null) {
      raw = Math.asin(Math.max(-1, Math.min(1, (hr - hf) / base)));
      pitch = cl(raw);
      gy = (hf + hr) * 0.5 + (zf + zr) * 0.5 * Math.sin(pitch);
    }
    if (Math.abs(raw) > CL) {
      const s = Math.sin(pitch), c2 = Math.cos(pitch);
      const hf2 = H(px + fx * zf * c2, pz + fz * zf * c2) ?? hf0, hr2 = H(px + fx * zr * c2, pz + fz * zr * c2) ?? hr0;
      const sag = Math.min(gy - zf * s - hf2, gy - zr * s - hr2);
      if (Number.isFinite(sag) && sag < 0) gy -= sag;
    }
    const s = Math.sin(pitch), c3 = Math.cos(pitch);
    const out = [zf, zr].map((z) => {
      const wx = px + fx * z * c3, wz = pz + fz * z * c3, wy = gy - z * s;
      const h = H(wx, wz);
      return h == null ? null : +((wy - h) * 1000).toFixed(1);
    });
    return { deg: +(raw * 180 / Math.PI).toFixed(3), clamped: Math.abs(raw) > CL, mm: out };
  };
  window.__ZF = [zf, zr];
}, RIDE);

/* ---- 1. VALIDATE the reproduction against the real game ---- */
const val = [];
for (const s of SITES) {
  const probe = await page.evaluate(([q, ride]) => window.WALLY.debug.parkProbe(q.x, q.z, q.yaw, ride), [s, RIDE]);
  const sim = await page.evaluate(([pr]) => window.__SIM(pr.machineAt[0], pr.machineAt[1], pr.yaw), [probe]);
  P('VALIDATE', { deg: probe.gradientDeg, simDeg: sim.deg,
    probeMM: (probe.wheels || []).map((w) => w.errMM), simMM: sim.mm,
    dDeg: +(probe.gradientDeg - sim.deg).toFixed(3),
    dMM: sim.mm.map((v, i) => +(v - (probe.wheels[i]?.errMM ?? 0)).toFixed(2)),
    probeClamped: probe.clamped, simClamped: sim.clamped });
  val.push({ dDeg: +(probe.gradientDeg - sim.deg).toFixed(3), dMM: sim.mm.map((v, i) => +(v - (probe.wheels[i]?.errMM ?? 0)).toFixed(2)), probeClamped: probe.clamped, simClamped: sim.clamped });
  await page.evaluate(() => { window.WALLY.ctx.wally.setBike(false, { instant: true }); });
}

const bad = val.filter((v) => Math.abs(v.dDeg) > 0.02 || v.dMM.some((d) => Math.abs(d) > 0.2) || v.probeClamped !== v.simClamped);
P('VALIDATE-MISMATCHES', bad.length);

/* ---- 2. the census, over the island ---- */
const cen = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  const buckets = {};   // 1-degree buckets of |gradient|
  let n = 0;
  const worst = [];
  for (let x = -900; x <= 900; x += 7) {
    for (let z = -900; z <= 900; z += 7) {
      const h = H(x, z); if (h == null || h < 0.4) continue;
      for (let a = 0; a < 8; a++) {
        const yaw = (a / 8) * Math.PI * 2;
        const px = x + Math.cos(yaw) * -0.62, pz = z - Math.sin(yaw) * -0.62;
        const r = window.__SIM(px, pz, yaw);
        if (!r || r.mm.some((v) => v == null)) continue;
        n++;
        const k = Math.min(60, Math.floor(Math.abs(r.deg)));
        const w = Math.max(Math.abs(r.mm[0]), Math.abs(r.mm[1]));
        const b = buckets[k] || (buckets[k] = { n: 0, worst: 0, over1: 0, over10: 0, under0: 0, at: null });
        b.n++;
        if (w > b.worst) { b.worst = w; b.at = [x, z, +yaw.toFixed(3), r.deg, r.mm[0], r.mm[1]]; }
        if (w > 1) b.over1++;
        if (w > 10) b.over10++;
        if (Math.min(r.mm[0], r.mm[1]) < -1) b.under0++;
      }
    }
  }
  return { n, buckets };
});
P('CENSUS-N', cen.n);
for (const k of Object.keys(cen.buckets).map(Number).sort((a, b) => a - b)) {
  P('BUCKET' + String(k).padStart(3), cen.buckets[k]);
}
P('ERRS', errs.slice(0, 8));
await close();
