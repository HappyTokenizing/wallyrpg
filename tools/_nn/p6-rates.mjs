/* WHEEL RATE AND PEDALLING DIRECTION, measured twice: once through
   WALLY.debug.driveTrace, and once by me, off a machine actually being
   ridden by the real controller under a real stick input — root
   displacement for the travel, the rear wheel's own unwrapped angle for
   the revolutions, and the foot/crank circles read in root-local space. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ wait: 4500 });

const RUNGS = { bike: [2.5, 5.1, 8.8], scooter: [3.8, 7.65, 13.2], motorcycle: [5, 9.9, 15.3] };

/* ---- 1. what the tool says ---- */
for (const ride of Object.keys(RUNGS)) {
  for (const s of RUNGS[ride]) {
    const t = await page.evaluate(([r, sp]) => {
      const t = window.WALLY.debug.driveTrace(r, sp, 48);
      return { ride: t.ride, req: t.rungRequested, target: t.rungTarget, measured: t.rungMeasured,
        cruise: t.sampledAtCruise, drift: t.sampleSpeedDriftPct, blocked: t.travelBlocked,
        demand: t.revPerMetreDemanded, deliver: t.revPerMetreDelivered, errPct: t.wheelRateErrPct,
        backStep: t.maxBackwardStepRad, dir: t.driveDirection, dzTop: t.dzAtTop,
        crankTurns: t.crankTurnsPerCycle, dist: t.metresTravelled, travel: t.travelAlongOwnForward };
    }, [ride, s]);
    P('TRACE', t);
  }
}

/* ---- 2. what I say, off a real ride ---- */
await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx, T = W.THREE;
  window.__RIDE = (ride, run) => new Promise((done) => {
    W.debug.giveRide(ride);
    const p = c.wally.rideProps[ride];
    const g = p.group;
    const wheel = p.wheels[1] || p.wheels[0];
    const R = wheel.position.y;
    const crank = p.crank || null;
    const rows = [];
    let n = 0;
    const TAU = Math.PI * 2;
    const unwrap = (d) => d - Math.round(d / TAU) * TAU;
    let prevW = wheel.rotation.x, prevC = crank ? crank.rotation.x : 0;
    let sumW = 0, sumC = 0, dist = 0, back = 0;
    const p0 = c.wally.root.position.clone();
    let prevP = p0.clone();
    const yaw0 = c.wally.root.rotation.y;
    const V = new T.Vector3();
    const tick = () => {
      /* the real stick, at full deflection, forward */
      W.debug.stick(0, 1);
      n++;
      if (n > 90) {          /* let it reach the rung first */
        const dw = unwrap(wheel.rotation.x - prevW);
        sumW += dw; if (dw < back) back = dw;
        if (crank) sumC += unwrap(crank.rotation.x - prevC);
        const P2 = c.wally.root.position;
        dist += Math.hypot(P2.x - prevP.x, P2.z - prevP.z);
        prevP.copy(P2);
        /* the foot, in root-local metres — forward is +z */
        const foot = c.wally.rig?.byName?.footL;
        if (foot) { V.set(0, 0, 0); foot.localToWorld(V); c.wally.root.worldToLocal(V); rows.push([+V.y.toFixed(4), +V.z.toFixed(4)]); }
      }
      prevW = wheel.rotation.x; prevC = crank ? crank.rotation.x : 0;
      if (n < 260) return requestAnimationFrame(tick);
      W.debug.stick(0, 0);
      const P2 = c.wally.root.position.clone();
      const fwd = new T.Vector3(Math.sin(yaw0), 0, Math.cos(yaw0));
      const travel = P2.clone().sub(p0).dot(fwd);
      /* dz at the top of the ankle circle */
      let bi = 0;
      for (let i = 1; i < rows.length - 1; i++) if (rows[i][0] > rows[bi][0]) bi = i;
      const dzTopAnkle = rows.length > 3 ? +(rows[bi + 1][1] - rows[bi][1]).toFixed(5) : null;
      done({ ride, R: +R.toFixed(4),
        distM: +dist.toFixed(3), travelAlongForward: +travel.toFixed(3),
        wheelRevs: +(sumW / TAU).toFixed(4),
        demandRevPerM: +(1 / (TAU * R)).toFixed(4),
        deliverRevPerM: dist > 0.5 ? +((sumW / TAU) / dist).toFixed(4) : null,
        errPct: dist > 0.5 ? +((((sumW / TAU) / dist) / (1 / (TAU * R)) - 1) * 100).toFixed(2) : null,
        crankRevs: crank ? +(sumC / TAU).toFixed(3) : null,
        maxBackStepRad: +back.toFixed(4),
        dzTopAnkleM: dzTopAnkle,
        n: rows.length });
    };
    requestAnimationFrame(tick);
  });
});

for (const ride of ['bike', 'scooter', 'motorcycle']) {
  for (const run of [false, true]) {
    const r = await page.evaluate(([rd, rn]) => window.__RIDE(rd, rn), [ride, run]);
    P('MINE', r);
    await page.evaluate(() => { window.WALLY.ctx.wally.setBike(false, { instant: true }); });
    await page.waitForTimeout(300);
  }
}
P('ERRS', errs.slice(0, 8));
await close();
