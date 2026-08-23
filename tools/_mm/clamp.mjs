/* _mm/clamp.mjs — VERIFY #1 and #3 in one boot.
   #1 the conform across the WHOLE 48-degree clamp, both wheel
      clearances at every rung, 45-48 included, on all three machines.
   #3 parkProbe's gradientDeg against the machine's OWN raw pitch,
      recomputed here independently at parkProp's offset position.
   Sites are chosen by that independent raw pitch, never by the chord
   under his feet. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();
await page.evaluate(() => { const a = window.WALLY.ctx.game.actions; a.grantRide('bike'); a.equipRide('bike'); });
await page.waitForTimeout(1800);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(1600);

const found = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  const p = c.wally.rideProps.bike;
  const cz = (w) => { let s = 0; for (let n = w; n && n !== p.group; n = n.parent) s += n.position.z; return s; };
  const ZF = cz(p.wheels[0]), ZR = cz(p.wheels[1]), base = ZF - ZR;
  const raw = (x, z, yaw) => {
    const ox = -0.62;
    const px = x + Math.cos(yaw) * ox, pz = z - Math.sin(yaw) * ox;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const hf = H(px + fx * ZF, pz + fz * ZF), hr = H(px + fx * ZR, pz + fz * ZR);
    if (hf == null || hr == null) return null;
    return Math.atan2(hr - hf, base) * 180 / Math.PI;
  };
  const out = {};
  for (let x = -700; x <= 700; x += 5) for (let z = -700; z <= 700; z += 5) {
    for (let k = 0; k < 8; k++) {
      const yaw = (k / 8) * Math.PI * 2;
      const r = raw(x, z, yaw); if (r == null) continue;
      /* half-degree buckets so 44..48 is actually covered */
      const b = (Math.round(Math.abs(r) * 2) / 2).toFixed(1);
      if (!out[b]) out[b] = { x, z, yaw: +yaw.toFixed(4), rawDeg: +r.toFixed(2) };
    }
  }
  return { out, base: +base.toFixed(3) };
});
P('wheelbase', found.base);
const want = ['2.0','5.0','8.0','12.0','16.0','20.0','25.0','30.0','35.0','40.0','43.0','44.0','44.5','45.0','45.5','46.0','46.5','47.0','47.5','48.0','49.0','52.0','60.0'];
let worst = 0, worstRow = null, disagree = 0;
for (const d of want) {
  const f = found.out[d]; if (!f) { P('miss', d); continue; }
  const r = await page.evaluate((q) => window.WALLY.debug.parkProbe(q.x, q.z, q.yaw, 'bike'), f);
  const mm = r.wheels.map((w) => w.errMM);
  const dg = Math.abs((r.gradientDeg ?? 999) - f.rawDeg);
  if (dg > 0.6) disagree++;
  const inside = Math.abs(f.rawDeg) <= 48;
  if (inside) { const m = Math.max(...mm.map(Math.abs)); if (m > worst) { worst = m; worstRow = f.rawDeg; } }
  P('rung', { indepRawDeg: f.rawDeg, probeGradientDeg: r.gradientDeg, dDeg: +dg.toFixed(2),
    clamped: r.clamped, pitchDeg: r.pitchDeg, wheelMM: mm });
}
P('SUMMARY', { worstInsideClampMM: worst, atDeg: worstRow, probeDisagreements: disagree });
for (const ride of ['scooter', 'motorcycle']) {
  for (const d of ['35.0','47.0']) {
    const f = found.out[d]; if (!f) continue;
    const r = await page.evaluate(([q, rr]) => window.WALLY.debug.parkProbe(q.x, q.z, q.yaw, rr), [f, ride]);
    P('other', { ride: r.ride, indepRawDeg: f.rawDeg, gradientDeg: r.gradientDeg, pitchDeg: r.pitchDeg, wheelMM: r.wheels.map((w) => w.errMM) });
  }
}
P('ERRS', errs.slice(0, 4));
await close();
