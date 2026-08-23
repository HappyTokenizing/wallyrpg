/* _hd/probecheck.mjs — the probe's own new fields, at a flat door pad
   and on a slope, so a reader can see what standFootMM now means and
   that errMM carries the digits its thresholds are applied at. */
import { boot } from '../_pj/lib.mjs';
const { page, errs, close } = await boot();
const out = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  const rows = [];
  const _n = new (W.THREE.Vector3)();
  const sites = [[-22.37, -34.2, 0.37], [-14.17, -84.46, 2.41], [226.04, -84.295, 1.19]];
  for (const [x, z, yaw] of sites) {
    for (const ride of ['bike', 'scooter', 'motorcycle']) {
      const p = W.debug.parkProbe(x, z, yaw, ride);
      if (p.error) { rows.push({ x, z, ride, error: p.error }); continue; }
      rows.push({ at: [x, z], ride, gradDeg: +(Math.acos(c.world.normalAt(x, z, _n).y) * 180 / Math.PI).toFixed(2),
        pitchDeg: p.pitchDeg, rollDeg: p.rollDeg, leanDeg: p.leanDeg, rollClamped: p.rollClamped,
        wheelMM: p.wheels.map((w) => w.errMM),
        standDesignMM: p.standDesignMM, standFootMM: p.standFootMM, standLowestVertexMM: p.standLowestVertexMM,
        machineAt: p.machineAt });
    }
  }
  return rows;
});
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
