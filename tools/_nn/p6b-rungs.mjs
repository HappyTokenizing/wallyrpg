/* The rungs that came back travelBlocked at the spawn point, re-run
   from open ground until the tool says the sample was taken at cruise.
   A rate figure off a machine that never reached its rung is not a
   rate figure, and driveTrace says so itself — this is taking it at
   its word rather than quoting the number anyway. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ wait: 4500 });
const SPOTS = [[-378, 198, 2.3562], [-336, -108, 3.1416], [-54, 222, 5.4978], [96, 18, 4.7124],
  [-174, 174, 1.5708], [-402, -108, 0.7854], [-417, -39, 4.7124], [-25, -389, 0.7854]];
const RUNGS = { bike: [5.1, 8.8], scooter: [7.65, 13.2], motorcycle: [9.9, 15.3] };
for (const ride of Object.keys(RUNGS)) {
  for (const s of RUNGS[ride]) {
    let best = null;
    for (const [x, z, yaw] of SPOTS) {
      const t = await page.evaluate(([q, rd, sp]) => {
        const W = window.WALLY, c = W.ctx;
        const h = c.world.heightAt(q[0], q[1]);
        c.wally.setPosition(q[0], Number.isFinite(h) ? h : 0, q[1]);
        c.wally.setYaw(q[2]);
        const t = W.debug.driveTrace(rd, sp, 48);
        return { spot: q, ride: t.ride, target: t.rungTarget, measured: t.rungMeasured,
          cruise: t.sampledAtCruise, drift: t.sampleSpeedDriftPct, blocked: t.travelBlocked,
          demand: t.revPerMetreDemanded, deliver: t.revPerMetreDelivered, errPct: t.wheelRateErrPct,
          backStep: t.maxBackwardStepRad, dir: t.driveDirection, dist: t.metresTravelled,
          travel: t.travelAlongOwnForward, crankTurns: t.crankTurnsPerCycle };
      }, [[x, z, yaw], ride, s]);
      best = t;
      if (t.cruise && !t.blocked) break;
    }
    P('RUNG', best);
  }
}
P('ERRS', errs.slice(0, 6));
await close();
