/* The -5.19% that turned up at a remote site: is the wheel really slow
   there, or is it a sample taken on a machine that never reached the
   rung and that sampledAtCruise/travelBlocked both waved through? */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ wait: 4500 });
for (const [x, z, yaw] of [[-54, 222, 5.4978], [-25, -389, 0.7854]]) {
  for (const sp of [1.5, 2.5, 5.1, 8.8]) {
    const t = await page.evaluate(([q, s]) => {
      const W = window.WALLY, c = W.ctx;
      const h = c.world.heightAt(q[0], q[1]);
      c.wally.setPosition(q[0], Number.isFinite(h) ? h : 0, q[1]);
      c.wally.setYaw(q[2]);
      const t = W.debug.driveTrace('bike', s, 48);
      return { at: q, ask: s, target: t.rungTarget, measured: t.rungMeasured,
        cruise: t.sampledAtCruise, drift: t.sampleSpeedDriftPct, blocked: t.travelBlocked,
        demand: t.revPerMetreDemanded, deliver: t.revPerMetreDelivered, errPct: t.wheelRateErrPct,
        dist: t.metresTravelled, travel: t.travelAlongOwnForward, warmFrames: t.warmFrames };
    }, [[x, z, yaw], sp]);
    P('SLOPE', t);
  }
}
P('ERRS', errs.slice(0, 6));
await close();
