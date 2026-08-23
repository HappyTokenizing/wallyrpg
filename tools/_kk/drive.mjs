/* _kk/drive.mjs — driveTrace on all three machines: the dz signs, the
   new noise-floored verdict, and whether the numbers reproduce. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();
for (const ride of ['bike', 'scooter', 'motorcycle']) {
  await page.evaluate((r) => window.WALLY.ctx.game.actions.grantRide(r), ride);
  const t = await page.evaluate((r) => {
    const d = window.WALLY.debug.driveTrace(r, r === 'motorcycle' ? 11 : 5.2, 48);
    return { ride: d.ride, dzTop: d.dzAtTop, dir: d.driveDirection, floor: d.dzNoiseFloorM,
      sampledAtCruise: d.sampledAtCruise, rungMeasured: d.rungMeasured,
      travelBlocked: d.travelBlocked, wheelRateErrPct: d.wheelRateErrPct,
      maxBackwardStepRad: d.maxBackwardStepRad, fitMaxMM: d.fitMaxMM, fitDriftMM: d.fitDriftMM };
  }, ride);
  P('trace', t);
}
P('ERRS', errs.slice(0, 4));
await close();
