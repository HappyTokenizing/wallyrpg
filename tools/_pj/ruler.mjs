/* _pj/ruler.mjs — the drivetrain ruler, sampled two ways.
   A) STATIONARY: N calls from ONE spot, no movement between them.
   B) MOVING: N calls, moved and re-yawed between them (the wheel mark's
      phase is set by accumulated distance, so a fixed spot exercises a
      narrow band of phases and a moving one a wide band; neither alone
      is the population).
   Counts 'rev' verdicts on a wheel whose measured rate error is 0.00%,
   and counts sampledAtCruise === false on those same exact samples.
   node tools/_pj/ruler.mjs <n>
*/
import { boot } from './lib.mjs';
const N = +(process.argv[2] || 24);
const { page, errs, close } = await boot();
const out = await page.evaluate((n) => {
  const W = window.WALLY, c = W.ctx;
  const jobs = [['bike', 5.2], ['bike', 8.2], ['scooter', 7.0], ['motorcycle', 15.3]];
  const res = [];
  const P0 = c.wally.root.position.clone();
  for (const mode of ['stationary', 'moving']) {
    for (const [ride, rung] of jobs) {
      const R = [];
      c.wally.setPosition(P0.x, P0.y, P0.z); c.wally.setYaw(0);
      for (let i = 0; i < n; i++) {
        if (mode === 'moving') {
          const a = i * 0.7, r = 3 + (i % 5) * 2.3;
          c.wally.setPosition(P0.x + Math.cos(a) * r, P0.y, P0.z + Math.sin(a) * r);
          c.wally.setYaw(a * 1.31);
        }
        const t = W.debug.driveTrace(ride, rung, 48);
        R.push({ dir: t.driveDirection.wheelMark, ankle: t.driveDirection.ankle, pedal: t.driveDirection.pedal,
          dz: t.dzAtTop.wheelMark, cross: t.wheelRollVsTravel, cruise: t.sampledAtCruise,
          plateau: t.plateauReached, warm: t.warmFrames, rung: t.rungMeasured, want: t.rungTarget,
          trend: t.sampleTrendPct, spread: t.sampleSpreadPct, drift: t.sampleSpeedDriftPct,
          rate: t.wheelRateErrPct, blocked: t.travelBlocked, travel: t.travelAlongOwnForward,
          revs: t.wheelRevs, backStep: t.maxBackwardStepRad, maxStep: t.maxWheelStepRad });
      }
      c.wally.setPosition(P0.x, P0.y, P0.z);
      const exact = R.filter((r) => r.rate != null && Math.abs(r.rate) < 0.005);
      res.push({ mode, ride, rung, n,
        wheelRev: R.filter((r) => r.dir === 'rev').length,
        wheelRevOnExact: exact.filter((r) => r.dir === 'rev').length,
        wheelNone: R.filter((r) => r.dir === 'none').length,
        crossDisagree: R.filter((r) => r.cross === 'disagree').length,
        exactSamples: exact.length,
        notCruise: R.filter((r) => !r.cruise).length,
        notCruiseOnExact: exact.filter((r) => !r.cruise).length,
        notPlateauOnExact: exact.filter((r) => !r.plateau).length,
        blocked: R.filter((r) => r.blocked).length,
        rateRange: [Math.min(...R.map((r) => r.rate)), Math.max(...R.map((r) => r.rate))],
        rungRange: [Math.min(...R.map((r) => r.rung)), Math.max(...R.map((r) => r.rung))],
        warmRange: [Math.min(...R.map((r) => r.warm)), Math.max(...R.map((r) => r.warm))],
        trendMax: Math.max(...R.map((r) => r.trend)), spreadMax: Math.max(...R.map((r) => r.spread)),
        dzRange: [Math.min(...R.map((r) => r.dz)), Math.max(...R.map((r) => r.dz))],
        dirSet: [...new Set(R.map((r) => r.ankle + '/' + r.pedal + '/' + r.dir))],
        backStepWorst: Math.min(...R.map((r) => r.backStep)),
        travelSigns: [...new Set(R.map((r) => Math.sign(r.travel)))],
        revSigns: [...new Set(R.map((r) => Math.sign(r.revs)))],
        badRows: R.filter((r) => r.dir === 'rev' || r.cross === 'disagree' || (!r.cruise && Math.abs(r.rate) < 0.005))
          .slice(0, 6).map((r) => ({ dir: r.dir, dz: r.dz, cross: r.cross, cruise: r.cruise, plateau: r.plateau,
            warm: r.warm, rung: r.rung, want: r.want, trend: r.trend, spread: r.spread, rate: r.rate })) });
    }
  }
  return res;
}, N);
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 5));
await close();
