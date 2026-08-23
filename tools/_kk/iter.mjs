/* _kk/iter.mjs — current parkProp arithmetic vs one and two refinement
   passes, on the SAME sites, measured against the ground under the
   contacts where the rotation actually puts them. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();
await page.evaluate(() => { const a = window.WALLY.ctx.game.actions; a.grantRide('bike'); a.equipRide('bike'); });
await page.waitForTimeout(1800);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(1600);

const out = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  const p = c.wally.rideProps.bike;
  const cz = (w) => { let s = 0; for (let n = w; n && n !== p.group; n = n.parent) s += n.position.z; return s; };
  const ZF = cz(p.wheels[0]), ZR = cz(p.wheels[1]);
  const base = ZF - ZR, MAX = 0.838;
  const cl = (v, a, b) => Math.max(a, Math.min(b, v));
  const setup = (x, z, yaw) => {
    const ox = -0.62;
    return { px: x + Math.cos(yaw) * ox, pz: z - Math.sin(yaw) * ox, fx: Math.sin(yaw), fz: Math.cos(yaw) };
  };
  /* error of a (gy, pitch) placement, measured at the true contacts */
  const err = (s, gy, pitch) => {
    const cf = Math.cos(pitch), sf = Math.sin(pitch);
    return [ZF, ZR].map((zi) => {
      const h = H(s.px + s.fx * zi * cf, s.pz + s.fz * zi * cf);
      return h == null ? null : +(((gy - zi * sf) - h) * 1000).toFixed(1);
    });
  };
  const CUR = (s) => {
    const hf = H(s.px + s.fx * ZF, s.pz + s.fz * ZF), hr = H(s.px + s.fx * ZR, s.pz + s.fz * ZR);
    if (hf == null || hr == null) return null;
    const raw = Math.atan2(hr - hf, base);
    const pitch = cl(raw, -MAX, MAX);
    let gy = (hf + hr) * 0.5;
    if (Math.abs(raw) > MAX) {
      const sg = Math.sin(pitch);
      const sag = Math.min(gy - ZF * sg - hf, gy - ZR * sg - hr);
      if (sag < 0) gy -= sag;
    }
    return { raw, gy, pitch };
  };
  /* N refinement passes: re-sample where the contacts LAND, solve the
     exact relation gy - z sin p = H(z cos p). */
  const ITER = (s, N) => {
    const c0 = CUR(s); if (!c0) return null;
    let pitch = c0.raw, gy = c0.gy, raw = c0.raw;
    for (let i = 0; i < N; i++) {
      const cf = Math.cos(cl(pitch, -MAX, MAX));
      const Hf = H(s.px + s.fx * ZF * cf, s.pz + s.fz * ZF * cf);
      const Hr = H(s.px + s.fx * ZR * cf, s.pz + s.fz * ZR * cf);
      if (Hf == null || Hr == null) break;
      raw = Math.asin(cl((Hr - Hf) / base, -1, 1));
      pitch = cl(raw, -MAX, MAX);
      gy = (Hf + Hr) * 0.5 + ((ZF + ZR) * 0.5) * Math.sin(pitch);
      if (Math.abs(raw) > MAX) {
        const sg = Math.sin(pitch), cf2 = Math.cos(pitch);
        const hf2 = H(s.px + s.fx * ZF * cf2, s.pz + s.fz * ZF * cf2);
        const hr2 = H(s.px + s.fx * ZR * cf2, s.pz + s.fz * ZR * cf2);
        const sag = Math.min(gy - ZF * sg - hf2, gy - ZR * sg - hr2);
        if (Number.isFinite(sag) && sag < 0) gy -= sag;
      }
    }
    return { raw, gy, pitch };
  };
  /* site search on the CURRENT raw pitch, so the ladder is comparable */
  const found = {};
  for (let x = -700; x <= 700; x += 5) for (let z = -700; z <= 700; z += 5) {
    for (let k = 0; k < 8; k++) {
      const yaw = (k / 8) * Math.PI * 2;
      const s = setup(x, z, yaw);
      const q = CUR(s); if (!q) continue;
      const b = Math.round(Math.abs(q.raw * 180 / Math.PI));
      if (!found[b]) found[b] = { x, z, yaw: +yaw.toFixed(4) };
    }
  }
  const want = [2, 5, 8, 12, 16, 20, 25, 30, 35, 40, 43, 45, 46, 47, 48, 50, 55, 60];
  const rows = [];
  for (const d of want) {
    const f = found[d]; if (!f) { rows.push({ want: d, miss: true }); continue; }
    const s = setup(f.x, f.z, f.yaw);
    const a = CUR(s), b1 = ITER(s, 1), b2 = ITER(s, 2);
    rows.push({ want: d, site: [f.x, f.z, f.yaw],
      curDeg: +(a.raw * 180 / Math.PI).toFixed(2), cur: err(s, a.gy, a.pitch),
      it1Deg: +(b1.raw * 180 / Math.PI).toFixed(2), it1: err(s, b1.gy, b1.pitch),
      it2: err(s, b2.gy, b2.pitch) });
  }
  /* WHOLE-ISLAND CENSUS, not four sites: every 5 m, 4 headings */
  const census = { n: 0, curWorst: 0, it1Worst: 0, curOver10: 0, it1Over10: 0, curOver50: 0, it1Over50: 0 };
  for (let x = -700; x <= 700; x += 10) for (let z = -700; z <= 700; z += 10) {
    for (let k = 0; k < 4; k++) {
      const yaw = (k / 4) * Math.PI * 2;
      const s = setup(x, z, yaw);
      const a = CUR(s); if (!a || Math.abs(a.raw) > MAX) continue;   // inside the clamp only
      const b1 = ITER(s, 1); if (!b1) continue;
      const ea = err(s, a.gy, a.pitch).map((v) => Math.abs(v || 0));
      const eb = err(s, b1.gy, b1.pitch).map((v) => Math.abs(v || 0));
      const wa = Math.max(...ea), wb = Math.max(...eb);
      census.n++;
      census.curWorst = Math.max(census.curWorst, wa);
      census.it1Worst = Math.max(census.it1Worst, wb);
      if (wa > 10) census.curOver10++;
      if (wb > 10) census.it1Over10++;
      if (wa > 50) census.curOver50++;
      if (wb > 50) census.it1Over50++;
    }
  }
  return { rows, census };
});
for (const r of out.rows) P('ladder', r);
P('census', out.census);
P('ERRS', errs.slice(0, 4));
await close();
