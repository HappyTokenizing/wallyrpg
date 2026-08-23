/* MY OWN RATE AND DIRECTION MEASUREMENT, taken off the real game loop
   at real frame times rather than driveTrace's hand-stepped one.

   FIRST ATTEMPT WAS WRONG AND THIS SAYS SO. Differencing the wheel's
   own rotation.x frame to frame and unwrapping into (-pi, pi] loses a
   whole turn whenever the wheel turns more than half a revolution
   between two frames — and headless SwiftShader runs at 8-20 fps, so
   at 8.8 m/s it does. That instrument reported the bicycle 33-40%
   slow on a drivetrain that is exact. The wheel angle is therefore
   read two ways here: from the prop's ODOMETER (metres of ground fed
   to roll(), which cannot alias) and from the angle itself with the
   per-frame dt printed beside it, so an aliased sample can be seen
   for what it is. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ wait: 4500 });

await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx, T = W.THREE;
  window.__DRIVE = (ride, mag, run, secs) => new Promise((done) => {
    W.debug.giveRide(ride);
    const p = c.wally.rideProps[ride];
    const ctrl = c.wally.controller;
    const wheel = p.wheels[1] || p.wheels[0];
    const R = wheel.position.y;
    const crank = p.crank || null;
    const yaw0 = c.wally.root.rotation.y;
    const saved = ctrl._inputFn || null;
    ctrl.setInputFn(() => ({ x: Math.sin(yaw0) * mag, z: Math.cos(yaw0) * mag, run: !!run }));
    const p0 = c.wally.root.position.clone();
    let prevP = p0.clone(), prevA = wheel.rotation.x, prevC = crank ? crank.rotation.x : 0;
    let odo0 = null, dist = 0, sumA = 0, sumC = 0, back = 0, t0 = performance.now(), lastT = t0;
    let dtMin = 1e9, dtMax = 0, frames = 0, warm = 0;
    const rows = [];
    const TAU = Math.PI * 2;
    const foot = c.wally.bones ? c.wally.bones.footL : null;
    const V = new T.Vector3();
    const tick = () => {
      const now = performance.now(), dt = (now - lastT) / 1000; lastT = now;
      frames++;
      if (warm < 45) {                       /* let it reach the rung */
        warm++; prevP.copy(c.wally.root.position);
        prevA = wheel.rotation.x; prevC = crank ? crank.rotation.x : 0;
        odo0 = p.odometer; t0 = now;
        return requestAnimationFrame(tick);
      }
      if (dt < dtMin) dtMin = dt; if (dt > dtMax) dtMax = dt;
      const P2 = c.wally.root.position;
      const step = Math.hypot(P2.x - prevP.x, P2.z - prevP.z);
      dist += step;
      prevP.copy(P2);
      /* dt-aware unwrap: pick the branch nearest the roll the ground
         demands this frame, instead of the branch nearest zero */
      const expect = step / R;
      let d = wheel.rotation.x - prevA;
      d -= Math.round((d - expect) / TAU) * TAU;
      sumA += d; if (d < back) back = d;
      prevA = wheel.rotation.x;
      if (crank) { let dc = crank.rotation.x - prevC; dc -= Math.round(dc / TAU) * TAU; sumC += dc; prevC = crank.rotation.x; }
      if (foot) { V.set(0, 0, 0); foot.localToWorld(V); c.wally.root.worldToLocal(V); rows.push([V.y, V.z]); }
      if ((now - t0) / 1000 < secs) return requestAnimationFrame(tick);
      ctrl.setInputFn(saved);
      const P3 = c.wally.root.position.clone();
      const fwd = new T.Vector3(Math.sin(yaw0), 0, Math.cos(yaw0));
      const travel = P3.sub(p0).dot(fwd);
      const dOdo = p.odometer - odo0;
      let bi = 0;
      for (let i = 1; i < rows.length - 1; i++) if (rows[i][0] > rows[bi][0]) bi = i;
      done({ ride, R: +R.toFixed(4), mag, run: !!run,
        frames, dtMinMs: +(dtMin * 1000).toFixed(1), dtMaxMs: +(dtMax * 1000).toFixed(1),
        distM: +dist.toFixed(3), travelAlongForwardM: +travel.toFixed(3),
        odoM: +dOdo.toFixed(3), odoOverDist: dist > 1 ? +(dOdo / dist).toFixed(4) : null,
        demandRevPerM: +(1 / (TAU * R)).toFixed(4),
        deliverRevPerM_fromOdo: dist > 1 ? +((dOdo / (TAU * R)) / dist).toFixed(4) : null,
        errPct_fromOdo: dist > 1 ? +((((dOdo / (TAU * R)) / dist) / (1 / (TAU * R)) - 1) * 100).toFixed(2) : null,
        deliverRevPerM_fromAngle: dist > 1 ? +((sumA / TAU) / dist).toFixed(4) : null,
        wheelAngleSign: sumA > 0 ? '+' : '-', maxBackStepRad: +back.toFixed(4),
        crankRevs: crank ? +(sumC / TAU).toFixed(3) : null, crankSign: crank ? (sumC > 0 ? '+' : '-') : null,
        ankleTopDzM: rows.length > 3 ? +(rows[bi + 1][1] - rows[bi][1]).toFixed(5) : null,
        ankleSamples: rows.length });
    };
    requestAnimationFrame(tick);
  });
});

for (const [ride, mag, run] of [['bike', 0.49, false], ['bike', 1, false], ['bike', 1, true],
  ['scooter', 1, false], ['scooter', 1, true], ['motorcycle', 1, false], ['motorcycle', 1, true]]) {
  const r = await page.evaluate(([rd, m, rn]) => window.__DRIVE(rd, m, rn, 3.5), [ride, mag, run]);
  P('MINE', r);
  await page.evaluate(() => { window.WALLY.ctx.wally.setBike(false, { instant: true }); });
  await page.waitForTimeout(400);
}
P('ERRS', errs.slice(0, 6));
await close();
