/* _zz/ruler.mjs — driveTrace, called N times from the same spot, at
   several rungs and on all three machines. Counts how often it calls a
   correct wheel reversed and how often sampledAtCruise reads false on a
   sample whose rate error is exact.
   node tools/_zz/ruler.mjs <n>
*/
import { boot } from '../_jj/lib.mjs';
const N = +(process.argv[2] || 18);
const { page, errs, close } = await boot();
const out = await page.evaluate((n) => {
  const W = window.WALLY, c = W.ctx;
  const runs = [];
  const jobs = [['bike', 5.2], ['bike', 8.2], ['scooter', 7.0], ['motorcycle', 15.3]];
  for (const [ride, rung] of jobs) {
    const R = [];
    const P0 = c.wally.root.position.clone();
    for (let i = 0; i < n; i++) {
      /* MOVE HIM BETWEEN CALLS. The wheel mark's phase is set by
         accumulated DISTANCE, so calling from one spot exercises one
         phase and the index the maximum lands on never changes. The
         wrap bug only fires when the highest sample lands on the
         second-to-last index, so a repeatability test that does not
         move is a test of nothing. */
      const a = i * 0.7, r = 3 + (i % 5) * 2.3;
      c.wally.setPosition(P0.x + Math.cos(a) * r, P0.y, P0.z + Math.sin(a) * r);
      c.wally.setYaw(a * 1.31);
      const t = W.debug.driveTrace(ride, rung, 48);
      R.push({
        dir: t.driveDirection.wheelMark, dz: t.dzAtTop.wheelMark,
        cross: t.wheelRollVsTravel,
        cruise: t.sampledAtCruise, plateau: t.plateauReached,
        warm: t.warmFrames, rung: t.rungMeasured, want: t.rungTarget,
        trend: t.sampleTrendPct, spread: t.sampleSpreadPct, drift: t.sampleSpeedDriftPct,
        rate: t.wheelRateErrPct, blocked: t.travelBlocked,
        ankle: t.driveDirection.ankle, pedal: t.driveDirection.pedal,
      });
    }
    c.wally.setPosition(P0.x, P0.y, P0.z);
    const rev = R.filter((r) => r.dir === 'rev').length;
    const dis = R.filter((r) => r.cross === 'disagree').length;
    const notCruise = R.filter((r) => !r.cruise).length;
    /* the false alarm: not-at-cruise on a sample whose rate is exact and
       whose rung was reached */
    const falseAlarm = R.filter((r) => !r.cruise && Math.abs(r.rate) < 0.5
      && !r.blocked && Math.abs(r.rung - r.want) / r.want < 0.01).length;
    runs.push({ ride, rung, n,
      wheelRev: rev, crossDisagree: dis, notAtCruise: notCruise, falseAlarm,
      rateRange: [Math.min(...R.map((r) => r.rate)), Math.max(...R.map((r) => r.rate))],
      rungRange: [Math.min(...R.map((r) => r.rung)), Math.max(...R.map((r) => r.rung))],
      warmRange: [Math.min(...R.map((r) => r.warm)), Math.max(...R.map((r) => r.warm))],
      trendRange: [Math.min(...R.map((r) => r.trend)), Math.max(...R.map((r) => r.trend))],
      spreadMax: Math.max(...R.map((r) => r.spread)),
      driftMax: Math.max(...R.map((r) => r.drift)),
      dirs: [...new Set(R.map((r) => r.ankle + '/' + r.pedal + '/' + r.dir))],
      dzRange: [Math.min(...R.map((r) => r.dz)), Math.max(...R.map((r) => r.dz))],
      crosses: [...new Set(R.map((r) => r.cross))],
      blocked: R.filter((r) => r.blocked).length,
      first: R[0],
      notCruiseRows: R.filter((r) => !r.cruise).map((r) => ({ plateau: r.plateau, warm: r.warm, rung: r.rung, want: r.want, trend: r.trend, spread: r.spread, drift: r.drift, rate: r.rate, blocked: r.blocked })),
    });
  }
  return runs;
}, N);
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
