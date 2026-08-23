/* _jj/clamp2.mjs — the clamp, measured on the gradient the CODE sees.

   clamp.mjs picked sites by the chord under Wally's feet, and
   WALLY.debug.parkProbe reports that same number as `gradientDeg`.
   Neither is the gradient the machine is parked on: parkProp() offsets
   the machine 0.62 m to his -x side and then samples the chord through
   the two wheel contacts THERE. On a cliff those are different hills.
   So: reproduce parkProp's own two samples, search for sites whose RAW
   pitch lands either side of PARK_PITCH_MAX, and probe those. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();

await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  /* parkProp's own arithmetic, reproduced */
  window.__C = {
    raw(x, z, yaw) {
      const p = c.wally.rideProps.bike;
      const zf = 0.47, zr = -0.47;               // refined below off the real prop
      const ox = -0.62;
      const px = x + Math.cos(yaw) * ox, pz = z - Math.sin(yaw) * ox;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      let ZF = zf, ZR = zr;
      if (p && p.wheels && p.wheels.length > 1) {
        const cz = (w) => { let s = 0; for (let n = w; n && n !== p.group; n = n.parent) s += n.position.z; return s; };
        ZF = cz(p.wheels[0]); ZR = cz(p.wheels[1]);
      }
      const hf = H(px + fx * ZF, pz + fz * ZF), hr = H(px + fx * ZR, pz + fz * ZR);
      if (hf == null || hr == null) return null;
      const base = ZF - ZR;
      return { rawDeg: +(Math.atan2(hr - hf, base) * 180 / Math.PI).toFixed(2), base: +base.toFixed(3),
        machineAt: [+px.toFixed(1), +pz.toFixed(1)] };
    },
    H,
  };
});
/* build the bike prop so contactZ is real */
await page.evaluate(() => { const a = window.WALLY.ctx.game.actions; a.grantRide('bike'); a.equipRide('bike'); });
await page.waitForTimeout(1800);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(1600);
P('wheelbase', await page.evaluate(() => window.__C.raw(0, 0, 0)));

const found = await page.evaluate(() => {
  const out = {};
  for (let x = -700; x <= 700; x += 5) for (let z = -700; z <= 700; z += 5) {
    for (let k = 0; k < 8; k++) {
      const yaw = (k / 8) * Math.PI * 2;
      const r = window.__C.raw(x, z, yaw);
      if (!r) continue;
      const b = Math.round(Math.abs(r.rawDeg));
      if (!out[b]) out[b] = { x, z, yaw: +yaw.toFixed(3), ...r };
    }
  }
  return out;
});
const want = [8, 20, 35, 42, 45, 47, 49, 51, 55, 60];
for (const d of want) {
  const s = found[d];
  if (!s) { P('site-missing', d); continue; }
  const r = await page.evaluate((q) => {
    const o = window.WALLY.debug.parkProbe(q.x, q.z, q.yaw, 'bike');
    o.rawDegAtMachine = q.rawDeg;
    o.machineAt = q.machineAt;
    return o;
  }, s);
  P('clamp', { rawDeg: r.rawDegAtMachine, gradientDegAsProbeReportsIt: r.gradientDeg,
    clamped: Math.abs(r.rawDegAtMachine) > 48, pitchDeg: r.pitchDeg,
    wheelMM: r.wheels.map((w) => w.errMM), machineAt: r.machineAt });
}
P('ERRS', errs.slice(0, 5));
await close();
