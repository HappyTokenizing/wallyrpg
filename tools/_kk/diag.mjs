/* _kk/diag.mjs — WHY the conform fails at 47 deg inside its own clamp.
   Finds sites by parkProp's OWN raw pitch, then measures the ground
   under the contacts where they ACTUALLY land after Rx(pitch). */
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
  const raw = (x, z, yaw) => {
    const ox = -0.62;
    const px = x + Math.cos(yaw) * ox, pz = z - Math.sin(yaw) * ox;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const hf = H(px + fx * ZF, pz + fz * ZF), hr = H(px + fx * ZR, pz + fz * ZR);
    if (hf == null || hr == null) return null;
    return { r: Math.atan2(hr - hf, ZF - ZR), px, pz, fx, fz, hf, hr };
  };
  const analyse = (x, z, yaw) => {
    const q = raw(x, z, yaw); if (!q) return null;
    const gy = (q.hf + q.hr) * 0.5;
    const cf = Math.cos(q.r), sf = Math.sin(q.r);
    const cxF = q.px + q.fx * ZF * cf, czF = q.pz + q.fz * ZF * cf, yF = gy - ZF * sf;
    const cxR = q.px + q.fx * ZR * cf, czR = q.pz + q.fz * ZR * cf, yR = gy - ZR * sf;
    const gF = H(cxF, czF), gR = H(cxR, czR);
    return { rawDeg: +(q.r * 180 / Math.PI).toFixed(2), reachAfter: +(ZF * cf).toFixed(3),
      hSampled: [+q.hf.toFixed(3), +q.hr.toFixed(3)],
      hAtContact: [gF == null ? null : +gF.toFixed(3), gR == null ? null : +gR.toFixed(3)],
      errMM: [gF == null ? null : +((yF - gF) * 1000).toFixed(1), gR == null ? null : +((yR - gR) * 1000).toFixed(1)],
      profile: [-0.6, -0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45, 0.6]
        .map((d) => { const h = H(q.px + q.fx * d, q.pz + q.fz * d); return h == null ? null : +h.toFixed(3); }) };
  };
  const found = {};
  for (let x = -700; x <= 700; x += 5) for (let z = -700; z <= 700; z += 5) {
    for (let k = 0; k < 8; k++) {
      const yaw = (k / 8) * Math.PI * 2;
      const q = raw(x, z, yaw); if (!q) continue;
      const b = Math.round(Math.abs(q.r * 180 / Math.PI));
      if (!found[b]) found[b] = { x, z, yaw: +yaw.toFixed(4) };
    }
  }
  const want = [5, 8, 12, 16, 20, 25, 30, 35, 40, 43, 45, 46, 47, 48];
  return { ZF: +ZF.toFixed(3), ZR: +ZR.toFixed(3),
    rows: want.map((d) => (found[d] ? { want: d, site: found[d], ...analyse(found[d].x, found[d].z, found[d].yaw) } : { want: d, miss: true })) };
});
P('wheelbase', { ZF: out.ZF, ZR: out.ZR });
for (const r of out.rows) P('site', r);
P('ERRS', errs.slice(0, 4));
await close();
