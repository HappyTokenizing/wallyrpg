/* IS parkProbe'S GRADIENT THE MACHINE'S OR THE RIDER'S?
   At each site: the chord under the RIDER'S feet, the chord under the
   MACHINE (0.62 m to his -x), and what the probe prints. If the probe
   still published the rider's number the first column would be the
   match; the point of the check is that on sloped ground the two
   columns differ, so the comparison can actually discriminate.
   Also: rolling the wheels half a turn must not move the answer. */
import { boot, P } from './lib.mjs';
import { readFile } from 'node:fs/promises';
const SITES = JSON.parse(await readFile(new URL('./sites.json', import.meta.url), 'utf8'));
const { page, errs, close } = await boot({ wait: 4500 });
await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  c.wally.setBike(true, { ride: 'bike', instant: true });
  const p = c.wally.rideProps.bike, g = p.group;
  const cz = (w) => { let z = 0; for (let n = w; n && n !== g; n = n.parent) z += n.position.z; return z; };
  const zf = cz(p.wheels[0]), zr = cz(p.wheels[1]);
  c.wally.setBike(false, { instant: true });
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  const CL = 0.838, cl = (v) => Math.max(-CL, Math.min(CL, v));
  window.__CHORD = (px, pz, yaw) => {
    const base = zf - zr, fx = Math.sin(yaw), fz = Math.cos(yaw);
    const hf0 = H(px + fx * zf, pz + fz * zf), hr0 = H(px + fx * zr, pz + fz * zr);
    if (hf0 == null || hr0 == null) return null;
    const raw1 = Math.atan2(hr0 - hf0, base);
    const cf = Math.cos(cl(raw1));
    const hf = H(px + fx * zf * cf, pz + fz * zf * cf), hr = H(px + fx * zr * cf, pz + fz * zr * cf);
    const raw = (hf != null && hr != null) ? Math.asin(Math.max(-1, Math.min(1, (hr - hf) / base))) : raw1;
    return { deg: +(raw * 180 / Math.PI).toFixed(2), clamped: Math.abs(raw) > CL };
  };
});
let worst = 0, flips = 0;
for (const s of SITES) {
  const r = await page.evaluate(([q]) => {
    const W = window.WALLY;
    const rider = window.__CHORD(q.x, q.z, q.yaw);
    const px = q.x + Math.cos(q.yaw) * -0.62, pz = q.z - Math.sin(q.yaw) * -0.62;
    const machine = window.__CHORD(px, pz, q.yaw);
    const probe = W.debug.parkProbe(q.x, q.z, q.yaw, 'bike');
    return { rider, machine, probeDeg: probe.gradientDeg, probeClamped: probe.clamped,
      machineAt: probe.machineAt, expectAt: [+px.toFixed(3), +pz.toFixed(3)] };
  }, [s]);
  const d = (r.rider && r.machine) ? +Math.abs(r.rider.deg - r.machine.deg).toFixed(2) : null;
  const flip = r.rider && r.machine && r.rider.clamped !== r.machine.clamped;
  if (d != null && d > worst) worst = d;
  if (flip) flips++;
  P('PROBE', { site: [s.x, s.z], riderDeg: r.rider?.deg, machineDeg: r.machine?.deg,
    probeDeg: r.probeDeg, riderVsMachineDeg: d, riderClamped: r.rider?.clamped,
    machineClamped: r.machine?.clamped, probeClamped: r.probeClamped,
    probeMinusMachine: r.machine ? +(r.probeDeg - r.machine.deg).toFixed(2) : null,
    atMatches: JSON.stringify(r.machineAt) === JSON.stringify(r.expectAt) });
  await page.evaluate(() => { window.WALLY.ctx.wally.setBike(false, { instant: true }); });
}
P('SPREAD', { worstRiderVsMachineDeg: worst, sitesWhereClampedWouldFlip: flips });

/* the rolling-angle trap: half a turn on both wheels must not move it */
const roll = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  const a = W.debug.parkProbe(96, 18, 4.7124, 'bike');
  const p = c.wally.rideProps.bike;
  p.wheels.forEach((w) => { w.rotation.x += Math.PI; });
  const b = W.debug.parkProbe(96, 18, 4.7124, 'bike');
  return { before: a.wheels.map((w) => w.errMM), afterHalfTurn: b.wheels.map((w) => w.errMM) };
});
P('ROLLTRAP', roll);
P('ERRS', errs.slice(0, 6));
await close();
