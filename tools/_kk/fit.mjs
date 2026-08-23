/* _kk/fit.mjs — is the ankle-to-pedal fit really 50.2/23.5 mm?
   Traced cold, traced after a real equip, and traced twice in a row. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();
const trace = (r, s) => page.evaluate(([rr, ss]) => {
  const d = window.WALLY.debug.driveTrace(rr, ss, 48);
  return { fitMaxMM: d.fitMaxMM, fitMinMM: d.fitMinMM, fitDriftMM: d.fitDriftMM, meanOffsetMM: d.meanOffsetMM,
    rungMeasured: d.rungMeasured, sampledAtCruise: d.sampledAtCruise };
}, [r, s]);
await page.evaluate(() => window.WALLY.ctx.game.actions.grantRide('bike'));
P('cold', await trace('bike', 5.2));
P('cold-again', await trace('bike', 5.2));
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide('bike'));
await page.waitForTimeout(2200);
P('after-equip', await trace('bike', 5.2));
P('after-equip-again', await trace('bike', 5.2));
P('rung-8.2', await trace('bike', 8.2));
P('ERRS', errs.slice(0, 4));
await close();
