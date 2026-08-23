/* _jj/ruler2.mjs — the INDEPENDENT ruler, done properly.

   Round one reported "never settled" on five of six runs. That was my
   instrument, not the game: W is a CAMERA-relative wish, so holding it
   from a yaw I set myself sends him off down whatever heading the
   follow rig happens to have — into a hill, along a wall, anywhere.
   Point the camera down the clear line FIRST, then hold the key, and
   widen the plateau window from 0.8% to 1.5% of top speed. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();

const runway = { x: -480, z: 0, yaw: 3.142 };
const put = async (x, z, yaw) => {
  await page.evaluate(([px, pz, py]) => {
    const c = window.WALLY.ctx;
    const h = c.world.heightAt(px, pz);
    c.wally.setPosition(px, Number.isFinite(h) ? h : 14.5, pz);
    c.wally.setYaw(py);
    if (c.wally.controller) c.wally.controller.velocity.set(0, 0, 0);
  }, [x, z, yaw]);
  await page.waitForTimeout(1400);
};
const camYawErr = () => page.evaluate((want) => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const f = new T.Vector3(); c.camera.getWorldDirection(f); f.y = 0; f.normalize();
  const yaw = Math.atan2(f.x, f.z);
  let d = yaw - want; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
  return +d.toFixed(3);
}, runway.yaw);
async function drag(px) {
  await page.mouse.move(640, 380); await page.mouse.down();
  for (let k = 1; k <= 6; k++) { await page.mouse.move(640 + (px * k) / 6, 380); await page.waitForTimeout(30); }
  await page.mouse.up(); await page.waitForTimeout(420);
}
async function aimCam() {
  for (let i = 0; i < 30; i++) {
    const e = await camYawErr();
    if (Math.abs(e) < 0.09) return e;
    await drag(e > 0 ? -160 : 160);
  }
  return await camYawErr();
}

await page.evaluate(() => { const a = window.WALLY.ctx.game.actions; for (const r of ['bike', 'scooter', 'motorcycle']) a.grantRide(r); });
await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const rows = [];
  window.__R = { rows, on: false, start() { rows.length = 0; this.on = true; }, stop() { this.on = false; return rows; } };
  c._handles.push({ lateUpdate() {
    const S = window.__R; if (!S.on) return;
    const w = c.wally, b = w.bike, ct = w.controller;
    if (!b || !ct) return;
    const rear = b.wheels[1] || b.wheels[0];
    rows.push({ x: ct.simPosition.x, z: ct.simPosition.z, spd: ct.planarSpeed, yaw: w.root.rotation.y,
      wrot: rear.rotation.x, wr: rear.position.y, crank: b.crank ? b.crank.rotation.x : null });
  } });
});
await page.mouse.click(640, 400);

const TAU = Math.PI * 2;
function reduce(rows, tol = 0.015) {
  if (rows.length < 30) return { err: 'no rows', n: rows.length };
  const sp = rows.map((r) => r.spd);
  const top = sp.slice().sort((a, b) => b - a)[Math.floor(rows.length * 0.05)];
  let bi = 0, bl = 0, i = 0;
  while (i < rows.length) {
    if (Math.abs(sp[i] - top) <= top * tol) {
      let j = i; while (j < rows.length && Math.abs(sp[j] - top) <= top * tol) j++;
      if (j - i > bl) { bl = j - i; bi = i; }
      i = j;
    } else i++;
  }
  const R = rows.slice(bi, bi + bl);
  if (R.length < 20) return { err: 'never settled', top: +top.toFixed(3), best: bl, n: rows.length };
  let dist = 0;
  for (let k = 1; k < R.length; k++) dist += Math.hypot(R[k].x - R[k - 1].x, R[k].z - R[k - 1].z);
  let rad = 0, back = 0, crank = 0, crankBack = 0;
  for (let k = 1; k < R.length; k++) {
    let d = R[k].wrot - R[k - 1].wrot; d -= Math.round(d / TAU) * TAU;
    if (d < back) back = d; rad += d;
    if (R[k].crank != null) { let cd = R[k].crank - R[k - 1].crank; cd -= Math.round(cd / TAU) * TAU; if (cd < crankBack) crankBack = cd; crank += cd; }
  }
  const A = R[0], B = R[R.length - 1];
  const dx = B.x - A.x, dz = B.z - A.z, len = Math.hypot(dx, dz) || 1;
  const fwd = [Math.sin(B.yaw), Math.cos(B.yaw)];
  const r0 = R[0].wr;
  const dem = 1 / (TAU * r0), del = (rad / TAU) / dist;
  return { steadyFrames: R.length, ofTotal: rows.length, cruise: +top.toFixed(4),
    metres: +dist.toFixed(3), netDisplacementM: +len.toFixed(3),
    travelAlongOwnForwardM: +(dx * fwd[0] + dz * fwd[1]).toFixed(3),
    headingVsRootForwardDeg: +(Math.acos(Math.max(-1, Math.min(1, (dx * fwd[0] + dz * fwd[1]) / len))) * 180 / Math.PI).toFixed(1),
    wheelRevs: +(rad / TAU).toFixed(4), wheelRadius: +r0.toFixed(4),
    crankRevs: crank ? +(crank / TAU).toFixed(4) : null,
    crankSign: crank ? Math.sign(crank) : null,
    revPerMetreDemanded: +dem.toFixed(4), revPerMetreDelivered: +del.toFixed(4),
    wheelRateErrPct: +((del / dem - 1) * 100).toFixed(4),
    maxBackwardStepRad: +back.toFixed(5), maxBackwardCrankStepRad: +crankBack.toFixed(5) };
}

for (const ride of ['bike', 'scooter', 'motorcycle']) {
  for (const run of [false, true]) {
    await put(runway.x, runway.z, runway.yaw);
    await page.evaluate((r) => window.WALLY.ctx.game.actions.equipRide(r), ride);
    await page.waitForTimeout(1500);
    const e = await aimCam();
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__R.start());
    if (run) await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(11000);
    const rows = await page.evaluate(() => window.__R.stop());
    await page.keyboard.up('KeyW');
    if (run) await page.keyboard.up('ShiftLeft');
    P('INDEP ' + ride + (run ? ' RUN' : ' cruise'), { camYawErr: e, ...reduce(rows) });
  }
}
P('ERRS', errs.slice(0, 6));
await close();
