/* THE WORST SITES THE CENSUS FOUND, PUT BACK THROUGH THE REAL GAME.
   The census is a reproduction of parkProp's arithmetic; before any of
   it is believed, the sites it calls bad are re-parked through
   WALLY.debug.parkProbe — the real parkProp — and the residuals it
   reports are compared with the ones the reproduction predicted. */
import { boot, P } from './lib.mjs';
const SITES = [
  [458, -109, 4.712, -5.24], [353, -74, 1.571, 6.9], [388, -109, 1.571, 10.63],
  [416, -165, 4.712, -11.55], [416, 199, 4.712, -14.42], [423, 192, 3.142, -15.39],
  [-186, -347, 1.571, -21.99], [185, -256, 3.142, -36.04], [234, 325, 4.712, 44.34],
  [-151, -368, 0, -46.31], [87, -172, 0, 47.07], [472, -81, 4.712, -45.46],
  [164, -235, 1.571, -43.14], [-333, -242, 3.142, 48.24], [304, -291, 1.571, 50.1],
];
const { page, errs, close } = await boot({ wait: 4500 });
for (const [x, z, yaw, deg] of SITES) {
  const r = await page.evaluate(([q]) => {
    const W = window.WALLY, c = W.ctx;
    const H = (px, pz) => { try { const h = c.world.heightAt(px, pz); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
    const out = W.debug.parkProbe(q[0], q[1], q[2], 'bike');
    /* how rough is the ground here? the spread of heightAt over the
       machine's own footprint, so a cliff edge can be told from a street */
    const hs = [];
    for (let dx = -0.6; dx <= 0.6; dx += 0.2) for (let dz = -0.6; dz <= 0.6; dz += 0.2) {
      const h = H(q[0] + dx, q[1] + dz); if (h != null) hs.push(h);
    }
    return { probe: out, spreadM: hs.length ? +(Math.max(...hs) - Math.min(...hs)).toFixed(3) : null };
  }, [[x, z, yaw]]);
  P('WORST', { site: [x, z, yaw], censusDeg: deg,
    probeDeg: r.probe.gradientDeg, clamped: r.probe.clamped,
    wheelsMM: (r.probe.wheels || []).map((w) => w.errMM),
    machineAt: r.probe.machineAt, footprintSpreadM: r.spreadM });
  await page.evaluate(() => { window.WALLY.ctx.wally.setBike(false, { instant: true }); });
}
P('ERRS', errs.slice(0, 8));
await close();
