/* _hd/cruise2.mjs — the OTHER direction of the sampledAtCruise flag.
   _pj/cruise.mjs counted false-on-exact (the flag crying wolf). This
   counts the opposite: samples where sampledAtCruise reads TRUE while
   the machine never got near the rung it was asked for, because a
   controller pinned against geometry holds a perfectly steady speed and
   a steady speed is all the flag tests. driveTrace's own header says
   "read it first"; read first, those are waved through.

   THE RIG IS ONE PLACE AND MANY HEADINGS, deliberately. driveTrace
   saves and re-teleports the CONTROLLER around its own run, so every
   trace starts from the controller's position whatever the visual root
   was set to — a rig that walks the root around the island and reports
   per-site rows is reporting the same site 38 times. Yaw is the input
   this tool actually controls, so yaw is what it varies.
*/
import { boot } from '../_pj/lib.mjs';
const { page, errs, close } = await boot();
const out = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  const jobs = [['bike', 8.2], ['scooter', 13.2], ['motorcycle', 26.4]];
  const N = 24;
  const res = [];
  const ctrlAt = c.phys?.player?.position ? [+c.phys.player.position.x.toFixed(2), +c.phys.player.position.z.toFixed(2)] : null;
  for (const [ride, rung] of jobs) {
    let n = 0, cruiseT = 0, blockedN = 0, both = 0, bothShort = 0;
    const rows = [];
    for (let i = 0; i < N; i++) {
      const yaw = (i / N) * Math.PI * 2;
      c.wally.setYaw(yaw);
      const t = W.debug.driveTrace(ride, rung, 48);
      if (!t || t.rungTarget == null) continue;
      n++;
      const frac = t.rungMeasured / Math.max(t.rungTarget, 1e-6);
      if (t.sampledAtCruise) cruiseT++;
      if (t.travelBlocked) blockedN++;
      if (t.sampledAtCruise && t.travelBlocked) { both++;
        if (frac < 0.5) bothShort++;
        if (rows.length < 6) rows.push({ yawDeg: +(yaw * 180 / Math.PI).toFixed(1),
          rungMeasured: t.rungMeasured, rungTarget: t.rungTarget, fracOfRung: +frac.toFixed(3),
          trendPct: t.sampleTrendPct, spreadPct: t.sampleSpreadPct, plateau: t.plateauReached,
          travel: t.travelAlongOwnForward, expected: t.travelExpected,
          why: t.notCruiseBecause === undefined ? '(field not present)' : t.notCruiseBecause }); }
    }
    res.push({ ride, rung, traces: n, cruiseTrue: cruiseT, travelBlocked: blockedN,
      cruiseTrueAndBlocked: both, ofThoseUnderHalfTheRung: bothShort, rows });
  }
  c.wally.setYaw(0);
  return { controllerAt: ctrlAt, jobs: res };
});
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
