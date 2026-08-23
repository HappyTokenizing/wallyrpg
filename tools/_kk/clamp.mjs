/* _kk/clamp.mjs — the conform across the WHOLE clamp range, through the
   shipped parkProp path, plus the probe's own gradient cross-checked
   against the machine's. Sites are chosen by parkProp's OWN raw pitch
   (offset 0.62 m to his -x side), never by the chord under his feet. */
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
      const b = Math.round(Math.abs(r));
      if (!out[b]) out[b] = { x, z, yaw: +yaw.toFixed(4), rawDeg: +r.toFixed(2) };
    }
  }
  return out;
});
const want = [2, 5, 8, 12, 16, 20, 25, 30, 35, 40, 43, 45, 46, 47, 48, 50, 55, 60];
for (const d of want) {
  const f = found[d]; if (!f) { P('miss', d); continue; }
  const r = await page.evaluate((q) => window.WALLY.debug.parkProbe(q.x, q.z, q.yaw, 'bike'), f);
  P('clamp', { siteRawDeg: f.rawDeg, probeGradientDeg: r.gradientDeg, agree: Math.abs((r.gradientDeg ?? 999) - f.rawDeg) < 0.6,
    clamped: r.clamped, pitchDeg: r.pitchDeg, wheelMM: r.wheels.map((w) => w.errMM), machineAt: r.machineAt });
}
/* and the same on the other two machines */
for (const ride of ['scooter', 'motorcycle']) {
  const f = found[35] || found[30];
  const r = await page.evaluate(([q, rr]) => window.WALLY.debug.parkProbe(q.x, q.z, q.yaw, rr), [f, ride]);
  P('other', { ride: r.ride, gradientDeg: r.gradientDeg, pitchDeg: r.pitchDeg, wheelMM: r.wheels.map((w) => w.errMM) });
}
P('ERRS', errs.slice(0, 4));
await close();
