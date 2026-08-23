/* _pj/cruise.mjs — how often sampledAtCruise reads false on a sample
   whose rate error is 0.00%, separating the HONEST false (the machine
   really was not at cruise — blocked, or short of the rung) from the
   FALSE ALARM (exact rate, unblocked, rung reached, flag still false). */
import { boot } from './lib.mjs';
const { page, errs, close } = await boot();
const out = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  const P0 = c.wally.root.position.clone();
  const rows = [];
  const jobs = [['bike', 5.2, 'stationary'], ['bike', 8.2, 'stationary'], ['scooter', 7.0, 'stationary'],
    ['motorcycle', 15.3, 'stationary'], ['motorcycle', 15.3, 'moving'], ['motorcycle', 26.4, 'moving'],
    ['bike', 8.8, 'moving'], ['scooter', 13.2, 'moving']];
  for (const [ride, rung, mode] of jobs) {
    const R = [];
    for (let i = 0; i < 24; i++) {
      if (mode === 'moving') { const a = i * 0.7, r = 3 + (i % 5) * 2.3;
        c.wally.setPosition(P0.x + Math.cos(a) * r, P0.y, P0.z + Math.sin(a) * r); c.wally.setYaw(a * 1.31); }
      else { c.wally.setPosition(P0.x, P0.y, P0.z); c.wally.setYaw(0); }
      const t = W.debug.driveTrace(ride, rung, 48);
      R.push({ cruise: t.sampledAtCruise, plateau: t.plateauReached, blocked: t.travelBlocked,
        rate: t.wheelRateErrPct, rung: t.rungMeasured, want: t.rungTarget, warm: t.warmFrames,
        trend: t.sampleTrendPct, spread: t.sampleSpreadPct, dir: t.driveDirection.wheelMark });
    }
    c.wally.setPosition(P0.x, P0.y, P0.z);
    const exact = R.filter((r) => r.rate != null && Math.abs(r.rate) < 0.005);
    const reached = (r) => !r.blocked && Math.abs(r.rung - r.want) / Math.max(r.want, 1e-6) < 0.01;
    rows.push({ ride, rung, mode, n: R.length,
      exact: exact.length,
      falseOnExact: exact.filter((r) => !r.cruise).length,
      falseAlarm: exact.filter((r) => !r.cruise && reached(r)).length,
      honestFalse: exact.filter((r) => !r.cruise && !reached(r)).length,
      blocked: R.filter((r) => r.blocked).length,
      revVerdicts: R.filter((r) => r.dir === 'rev').length,
      detail: exact.filter((r) => !r.cruise).map((r) => ({ blocked: r.blocked, plateau: r.plateau,
        warm: r.warm, rung: r.rung, want: r.want, trend: r.trend, spread: r.spread, rate: r.rate })) });
  }
  return rows;
});
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
