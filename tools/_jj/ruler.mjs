/* _jj/ruler.mjs — THE RULER, at a rung it cannot reach, and then
   cross-checked against a measurement that shares none of its
   machinery.

   node tools/_jj/ruler.mjs
*/
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();

const pick = (t) => ({
  rungRequested: t.rungRequested, rungTarget: t.rungTarget, rungMeasured: t.rungMeasured,
  warmFrames: t.warmFrames, warmSpeed: t.warmSpeed, sampledAtCruise: t.sampledAtCruise,
  sampleSpeedDriftPct: t.sampleSpeedDriftPct,
  travelAlongOwnForward: t.travelAlongOwnForward, travelExpected: t.travelExpected,
  travelBlocked: t.travelBlocked, metresTravelled: t.metresTravelled,
  revDemand: t.revPerMetreDemanded, revDeliver: t.revPerMetreDelivered,
  wheelRateErrPct: t.wheelRateErrPct, maxBackwardStepRad: t.maxBackwardStepRad,
  dzTop: t.dzAtTop, dzBottom: t.dzAtBottom,
});
const trace = (ride, rung, n = 32) => page.evaluate(([r, s, nn]) => {
  const t = window.WALLY.debug.driveTrace(r, s, nn);
  return t;
}, [ride, rung, n]).then(pick);

const put = async (x, z, yaw) => {
  await page.evaluate(([px, pz, py]) => {
    const c = window.WALLY.ctx;
    const h = c.world.heightAt(px, pz);
    c.wally.setPosition(px, Number.isFinite(h) ? h : 14.5, pz);
    c.wally.setYaw(py);
    if (c.wally.controller) c.wally.controller.velocity.set(0, 0, 0);
  }, [x, z, yaw]);
  await page.waitForTimeout(1500);
};

await page.evaluate(() => { const a = window.WALLY.ctx.game.actions; for (const r of ['bike', 'scooter', 'motorcycle']) a.grantRide(r); });

/* --------------------------------------------------------------
   1. A RUNG IT CANNOT REACH. Two ways of not reaching one:
      (a) nose against a wall — no room at all;
      (b) the apartment door pocket, walled ~20 m down every heading,
          which is enough room for a bicycle and not for a motorcycle.
   -------------------------------------------------------------- */
const door = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const cy = c.world.city || c.city;
  const v = cy.doorPosition('apartment');
  return [v.x, v.z];
});
P('door', door.map((v) => +v.toFixed(1)));

/* find a wall to point at: march a ray out from the door until the
   collision world stops him */
const wall = await page.evaluate(([dx, dz]) => {
  const c = window.WALLY.ctx;
  const out = [];
  for (let k = 0; k < 16; k++) {
    const yaw = (k / 16) * Math.PI * 2;
    let reach = 40;
    if (c.phys?.raycast) {
      const T = window.WALLY.THREE;
      const o = new T.Vector3(dx, c.world.heightAt(dx, dz) + 1.0, dz);
      const d = new T.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const hit = c.phys.raycast(o, d, 40);
      if (hit && Number.isFinite(hit.distance)) reach = hit.distance;
    }
    out.push({ yaw: +yaw.toFixed(3), reach: +reach.toFixed(2) });
  }
  return out.sort((a, b) => a.reach - b.reach);
}, door);
P('headings-from-door (nearest wall first)', wall.slice(0, 3).concat(wall.slice(-2)));

const tight = wall[0];
await put(door[0], door[1], tight.yaw);
for (const [ride, rungs] of [['bike', [5.1, 8.8]], ['scooter', [7.65, 13.2]], ['motorcycle', [15.3, 26.4]]]) {
  for (const r of rungs) P('WALL ' + ride + '@' + r, await trace(ride, r));
}

/* --------------------------------------------------------------
   2. THE OPEN GROUND. Find the longest clear run on the island by
      asking the collision world, not by trusting a coordinate.
   -------------------------------------------------------------- */
const runway = await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  let best = null;
  for (let x = -600; x <= 600; x += 40) for (let z = -600; z <= 600; z += 40) {
    const y = c.world.heightAt(x, z);
    if (!Number.isFinite(y) || y < 1) continue;
    for (let k = 0; k < 8; k++) {
      const yaw = (k / 8) * Math.PI * 2;
      const o = new T.Vector3(x, y + 1.0, z);
      const d = new T.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      let reach = 300;
      if (c.phys?.raycast) { const h = c.phys.raycast(o, d, 300); if (h && Number.isFinite(h.distance)) reach = h.distance; }
      /* flat, too: a hill costs speed and that is not a wall */
      const h1 = c.world.heightAt(x + d.x * 30, z + d.z * 30);
      const grade = Number.isFinite(h1) ? Math.abs(h1 - y) / 30 : 9;
      if (grade > 0.05) continue;
      if (!best || reach > best.reach) best = { x, z, yaw: +yaw.toFixed(3), reach: +reach.toFixed(1) };
    }
  }
  return best;
});
P('runway', runway);
await put(runway.x, runway.z, runway.yaw);
const clear = {};
for (const [ride, rungs] of [['bike', [2.5, 5.1, 8.8]], ['scooter', [3.5, 7.65, 13.2]], ['motorcycle', [6, 15.3, 26.4]]]) {
  clear[ride] = {};
  for (const r of rungs) { const t = await trace(ride, r); clear[ride][r] = t; P('RUNWAY ' + ride + '@' + r, t); }
}

/* --------------------------------------------------------------
   3. THE INDEPENDENT RULER. No driveTrace, no hand-stepped
      controller, no phase lock. Mount for real, hold the key, let the
      game's own rAF loop run, and sample (wheel angle, controller
      position, root forward) off the live scene once a frame.

      THE HEADING IS MEASURED, NOT ASSUMED. W is a camera-relative
      wish (camera.js builds controller.input from the camera basis),
      so the direction he actually takes is the rig's, not any yaw set
      above. Travel is projected onto the displacement he actually
      made, and separately onto his own root forward, and both are
      reported.
   -------------------------------------------------------------- */
await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const rows = [];
  window.__R = { rows, on: false, start() { rows.length = 0; this.on = true; }, stop() { this.on = false; return rows; } };
  c._handles.push({ lateUpdate() {
    const S = window.__R; if (!S.on) return;
    const w = c.wally, b = w.bike, ct = w.controller;
    if (!b || !ct) return;
    const rear = b.wheels[1] || b.wheels[0];
    rows.push({ x: ct.simPosition.x, z: ct.simPosition.z, spd: ct.planarSpeed,
      yaw: w.root.rotation.y, wrot: rear.rotation.x, wr: rear.position.y,
      crank: b.crank ? b.crank.rotation.x : null });
  } });
});
await page.mouse.click(640, 400);

const TAU = Math.PI * 2;
function reduce(rows) {
  if (rows.length < 30) return { err: 'no rows', n: rows.length };
  const sp = rows.map((r) => r.spd);
  const top = sp.slice().sort((a, b) => b - a)[Math.floor(rows.length * 0.05)];
  let bi = 0, bl = 0, i = 0;
  while (i < rows.length) {
    if (Math.abs(sp[i] - top) <= top * 0.008) {
      let j = i; while (j < rows.length && Math.abs(sp[j] - top) <= top * 0.008) j++;
      if (j - i > bl) { bl = j - i; bi = i; }
      i = j;
    } else i++;
  }
  const R = rows.slice(bi, bi + bl);
  if (R.length < 20) return { err: 'never settled', top: +top.toFixed(3), best: bl };
  let dist = 0;
  for (let k = 1; k < R.length; k++) dist += Math.hypot(R[k].x - R[k - 1].x, R[k].z - R[k - 1].z);
  let rad = 0, back = 0, crank = 0;
  for (let k = 1; k < R.length; k++) {
    let d = R[k].wrot - R[k - 1].wrot; d -= Math.round(d / TAU) * TAU;
    if (d < back) back = d; rad += d;
    if (R[k].crank != null) { let cd = R[k].crank - R[k - 1].crank; cd -= Math.round(cd / TAU) * TAU; crank += cd; }
  }
  const A = R[0], B = R[R.length - 1];
  const dx = B.x - A.x, dz = B.z - A.z, len = Math.hypot(dx, dz) || 1;
  const fwd = [Math.sin(B.yaw), Math.cos(B.yaw)];
  const alongOwnForward = (dx * fwd[0] + dz * fwd[1]);
  const r0 = R[0].wr;
  const dem = 1 / (TAU * r0), del = (rad / TAU) / dist;
  return { steadyFrames: R.length, ofTotal: rows.length, cruise: +top.toFixed(4),
    metres: +dist.toFixed(4), netDisplacementM: +len.toFixed(3),
    travelAlongOwnForwardM: +alongOwnForward.toFixed(3),
    headingVsRootForwardDeg: +(Math.acos(Math.max(-1, Math.min(1, (dx * fwd[0] + dz * fwd[1]) / len))) * 180 / Math.PI).toFixed(1),
    wheelRevs: +(rad / TAU).toFixed(4), wheelRadius: +r0.toFixed(4),
    crankRevs: crank ? +(crank / TAU).toFixed(4) : null,
    revPerMetreDemanded: +dem.toFixed(4), revPerMetreDelivered: +del.toFixed(4),
    wheelRateErrPct: +((del / dem - 1) * 100).toFixed(4),
    maxBackwardStepRad: +back.toFixed(5) };
}

for (const ride of ['bike', 'scooter', 'motorcycle']) {
  for (const run of [false, true]) {
    await put(runway.x, runway.z, runway.yaw);
    await page.evaluate((r) => {
      const c = window.WALLY.ctx;
      c.game.actions.equipRide(r);
      window.WALLY.debug.locomotion?.(null);
    }, ride);
    await page.waitForTimeout(1600);
    await page.evaluate(() => window.__R.start());
    if (run) await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(9000);
    const rows = await page.evaluate(() => window.__R.stop());
    await page.keyboard.up('KeyW');
    if (run) await page.keyboard.up('ShiftLeft');
    P('INDEP ' + ride + (run ? ' run' : ' cruise'), reduce(rows));
  }
}
P('ERRS', errs.slice(0, 6));
await close();
