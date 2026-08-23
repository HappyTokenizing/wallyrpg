/* _pj/rates.mjs — rev/m demanded vs delivered at EVERY rung on EVERY
   machine, plus an INDEPENDENT direction-of-travel measurement that
   does not call driveTrace: real key input, world displacement, and the
   wheel's own accumulated rotation, read frame by frame. */
import { boot } from './lib.mjs';
const { page, errs, close } = await boot();

/* half one: driveTrace at every rung */
const A = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  const ladders = { bike: [1.5, 3.0, 5.10, 6.5, 8.80, 12.0], scooter: [2.0, 4.5, 7.65, 10.0, 13.20, 18.0],
    motorcycle: [3.0, 8.0, 15.30, 20.0, 26.40, 34.0] };
  const out = [];
  const P0 = c.wally.root.position.clone();
  for (const ride of Object.keys(ladders)) for (const rung of ladders[ride]) {
    c.wally.setPosition(P0.x, P0.y, P0.z); c.wally.setYaw(0.9);
    const t = W.debug.driveTrace(ride, rung, 48);
    out.push({ ride, req: t.rungRequested, target: t.rungTarget, measured: t.rungMeasured,
      cruise: t.sampledAtCruise, blocked: t.travelBlocked,
      demand: t.revPerMetreDemanded, deliver: t.revPerMetreDelivered, errPct: t.wheelRateErrPct,
      dirs: [t.driveDirection.ankle, t.driveDirection.pedal, t.driveDirection.wheelMark],
      cross: t.wheelRollVsTravel, travel: t.travelAlongOwnForward, revs: t.wheelRevs,
      backStep: t.maxBackwardStepRad, crankTurns: t.crankTurnsPerCycle });
  }
  c.wally.setPosition(P0.x, P0.y, P0.z);
  return out;
});

/* half two: the independent ruler. Mount through the game, hold a real
   key, and read world displacement, wheel rotation, crank rotation and
   ankle height straight off the scene every frame. Nothing here calls
   driveTrace or setLocomotion. */
const B = [];
for (const ride of ['bike', 'scooter', 'motorcycle']) {
  await page.evaluate((r) => { const a = window.WALLY.ctx.game.actions; a.equipRide(null); a.grantRide(r); a.equipRide(r); }, ride);
  await page.waitForTimeout(1800);
  await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  const r = await page.evaluate(async (rd) => {
    const W = window.WALLY, T = W.THREE, c = W.ctx;
    const p = c.wally.rideProps[rd]; if (!p) return { error: 'no prop' };
    const g = p.group, wheel = (p.wheels || [])[1] || (p.wheels || [])[0];
    const root = c.wally.root;
    const TAU = Math.PI * 2, unwrap = (d) => d - Math.round(d / TAU) * TAU;
    const frames = [];
    let prevRot = wheel.rotation.x, acc = 0;
    const p0 = root.position.clone();
    let prevCrank = p.crank ? p.crank.rotation.x : null, crankAcc = 0;
    /* the valve stem, in ROOT-LOCAL metres, so +z is forward */
    const mark = new T.Vector3();
    const wr = Math.abs(wheel.position.y);
    for (let i = 0; i < 90; i++) {
      await new Promise((res) => requestAnimationFrame(res));
      root.updateMatrixWorld(true);
      acc += unwrap(wheel.rotation.x - prevRot); prevRot = wheel.rotation.x;
      if (p.crank) { crankAcc += unwrap(p.crank.rotation.x - prevCrank); prevCrank = p.crank.rotation.x; }
      mark.set(0, wr, 0); wheel.updateMatrixWorld(true); mark.applyMatrix4(wheel.matrixWorld); root.worldToLocal(mark);
      frames.push({ x: root.position.x, z: root.position.z, my: mark.y, mz: mark.z });
    }
    const p1 = root.position.clone();
    const fwd = new T.Vector3(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
    const travel = p1.clone().sub(p0).dot(fwd);
    const dist = frames.reduce((s, f, i) => i ? s + Math.hypot(f.x - frames[i - 1].x, f.z - frames[i - 1].z) : 0, 0);
    /* dz of the mark at the top of ITS OWN circle, from the dense series */
    let bi = 0; for (let i = 1; i < frames.length - 1; i++) if (frames[i].my > frames[bi].my) bi = i;
    return { ride: rd, wheelRadius: +wr.toFixed(4), travelAlongForward: +travel.toFixed(4),
      distance: +dist.toFixed(4), wheelRevs: +(acc / TAU).toFixed(4),
      crankTurns: p.crank ? +(crankAcc / TAU).toFixed(4) : null,
      revPerMetreDelivered: dist > 0.05 ? +((acc / TAU) / dist).toFixed(4) : null,
      revPerMetreDemanded: +(1 / (TAU * wr)).toFixed(4),
      markDzAtTop: +(frames[bi + 1].mz - frames[bi].mz).toFixed(5),
      markTopIndex: bi, frames: frames.length };
  }, ride);
  await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
  await page.waitForTimeout(400);
  B.push(r);
}
console.log('DRIVETRACE ' + JSON.stringify(A, null, 1));
console.log('INDEPENDENT ' + JSON.stringify(B, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 5));
await close();
