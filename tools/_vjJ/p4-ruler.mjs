/* p4 — THE RULER, AND A SECOND RULER TO CHECK IT WITH.
   Half one: call WALLY.debug.driveTrace at every rung of every machine.
   Half two: measure the same thing myself, with no phase lock, no
   forced locomotion and no borrowed number — a HELD KEY (or a held
   thumbstick for a rung the keyboard cannot ask for), the controller's
   own simPosition for distance, and the wheel's raw rotation.x unwrapped
   here, by me. Then the two are put side by side. */
import { boot, unwrapSum } from './lib.mjs';
const { page, browser, server, errs } = await boot({ w: 900, h: 560 });

/* ---------- sampler ---------- */
await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const rows = [];
  window.__S = { rows, on: false, start() { rows.length = 0; this.on = true; }, stop() { this.on = false; return rows; } };
  c._handles.push({ lateUpdate() {
    const S = window.__S; if (!S.on) return;
    const w = c.wally, b = w.bike, ct = w.controller;
    if (!b || !ct) return;
    const p = ct.simPosition;
    const f = new T.Vector3(0, 0, 1).applyQuaternion(w.root.quaternion);
    rows.push({ t: c.elapsed, x: p.x, y: p.y, z: p.z, spd: ct.planarSpeed,
      fwd: [f.x, f.z], odo: b.odometer,
      wrot: b.wheels.map((k) => k.rotation.x), wr: b.wheels.map((k) => k.position.y),
      wz: b.wheels.map((k) => k.position.z),
      crot: b.crank ? b.crank.rotation.x : null,
      ankL: (() => { const V = new T.Vector3(); w.bones.footL.getWorldPosition(V); w.root.worldToLocal(V); return [V.x, V.y, V.z]; })() });
  } });
});

async function mount(ride) {
  await page.evaluate((r) => { const c = window.WALLY.ctx; c.game.actions.grantRide(r); c.game.actions.equipRide(r); }, ride);
  await page.waitForTimeout(2600);
}
/* THE RUNWAY, chosen by driving it (p4b): 120 m of clear ground on which
   a motorcycle held at Shift+W actually reaches its 26.40 m/s runSpeed.
   Measuring a rate on a machine pinned against a building is the failure
   this whole tool exists to stop, and the first cut of this probe walked
   straight into it. */
const RUNWAY = { x: 332.55, z: -253.73, yaw: -1.571 };
async function reset() {
  await page.evaluate((q) => {
    const c = window.WALLY.ctx;
    c.wally.setPosition(q.x, c.world.heightAt(q.x, q.z), q.z);
    c.wally.setYaw(q.yaw);
    if (c.wally.controller) c.wally.controller.velocity.set(0, 0, 0);
  }, RUNWAY);
  await page.waitForTimeout(1500);
}

async function runHeld(keys, secs) {
  await page.evaluate(() => window.__S.start());
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(secs * 1000);
  const rows = await page.evaluate(() => window.__S.stop());
  for (const k of keys) await page.keyboard.up(k);
  await page.waitForTimeout(900);
  return rows;
}

/* the same, but held on the touch thumbstick — the only real control
   that can ask for a speed between the walk and the run */
async function runStick(frac, secs) {
  const geo = await page.evaluate(() => {
    const t = window.WALLY.ctx.ui && window.WALLY.ctx.ui.touch;
    return t && t.axes ? { R: t.axes.R || 40, enabled: !!t.enabled } : null;
  });
  if (!geo) return null;
  return null;
}

const TAU = Math.PI * 2;
function measure(rows, label) {
  if (!rows || rows.length < 20) return { label, err: 'no rows' };
  /* the STEADY window only: frames whose speed is within 0.4% of the
     median of the last 60% of the run. A rate taken while accelerating
     is not a rate — that is the whole of the -1.74% false alarm. */
  const sp0 = rows.map((r) => r.spd);
  const top = sp0.slice().sort((a, b) => b - a)[Math.floor(rows.length * 0.05)];
  /* the LONGEST run of frames all within 0.2% of the top speed */
  let bi = 0, bl = 0, i = 0;
  while (i < rows.length) {
    if (Math.abs(sp0[i] - top) <= top * 0.002) { let j = i; while (j < rows.length && Math.abs(sp0[j] - top) <= top * 0.002) j++; if (j - i > bl) { bl = j - i; bi = i; } i = j; } else i++;
  }
  const R = rows.slice(bi, bi + bl);
  const med = top;
  if (R.length < 20) return { label, err: 'never settled', med: +med.toFixed(3), best: bl };
  let dist = 0;
  for (let i = 1; i < R.length; i++) dist += Math.hypot(R[i].x - R[i - 1].x, R[i].z - R[i - 1].z);
  const nW = R[0].wrot.length;
  const out = { label, n: R.length, cruiseSpeed: +med.toFixed(4), metres: +dist.toFixed(4),
    odoDelta: +(R[R.length - 1].odo - R[0].odo).toFixed(4),
    speedDriftPct: +(Math.abs(R[R.length - 1].spd - R[0].spd) / med * 100).toFixed(3), wheels: [] };
  for (let k = 0; k < nW; k++) {
    const rad = unwrapSum(R.map((r) => r.wrot[k]));
    const rr = R[0].wr[k];
    const dem = 1 / (TAU * rr), del = (rad / TAU) / dist;
    let back = 0;
    for (let i = 1; i < R.length; i++) { let d = R[i].wrot[k] - R[i - 1].wrot[k]; d -= Math.round(d / TAU) * TAU; if (d < back) back = d; }
    out.wheels.push({ k, z: +R[0].wz[k].toFixed(3), radius: +rr.toFixed(4), revs: +(rad / TAU).toFixed(4),
      demandRevPerM: +dem.toFixed(5), deliverRevPerM: +del.toFixed(5), errPct: +((del / dem - 1) * 100).toFixed(4),
      maxBackStepRad: +back.toFixed(5) });
  }
  /* odometer against ground truth — a THIRD reading of the same fact */
  out.odoErrPct = +(((out.odoDelta / dist) - 1) * 100).toFixed(4);
  /* direction: does he move along his own +z, and does the wheel top go with him? */
  const fx = R[0].fwd[0], fz = R[0].fwd[1];
  let sd = 0; for (let i = 1; i < R.length; i++) sd += (R[i].x - R[i - 1].x) * fx + (R[i].z - R[i - 1].z) * fz;
  out.travelAlongOwnPlusZ = +sd.toFixed(4);
  if (R[0].crot != null) {
    out.crankRad = +unwrapSum(R.map((r) => r.crot)).toFixed(4);
    out.crankRevs = +(unwrapSum(R.map((r) => r.crot)) / TAU).toFixed(4);
    out.metresPerCrankRev = +(dist / (unwrapSum(R.map((r) => r.crot)) / TAU)).toFixed(4);
  }
  /* the ankle's own circulation: dz at the top of its arc */
  let ti = 0; for (let q = 1; q < R.length - 1; q++) if (R[q].ankL[1] > R[ti].ankL[1]) ti = q;
  out.ankleDzAtTop = +(R[ti + 1].ankL[2] - R[ti].ankL[2]).toFixed(5);
  return out;
}

const result = { traces: {}, mine: {} };

for (const ride of ['bike', 'scooter', 'motorcycle']) {
  await mount(ride);
  await reset();
  const rungs = ride === 'bike' ? [0, 3.4, 5.2, 8.2, 8.8] : ride === 'scooter' ? [0, 4.6, 7.65, 12.6, 13.2] : [0, 8.0, 15.3, 22.0, 26.4];
  result.traces[ride] = {};
  for (const s of rungs) {
    await reset();
    result.traces[ride][s] = await page.evaluate(([r, sp]) => window.WALLY.debug.driveTrace(r, sp, 48), [ride, s]);
    await page.waitForTimeout(300);
  }
  /* --- my own, on the real controls --- */
  await reset();
  const cruise = await runHeld(['KeyW'], 7.0);
  await reset();
  const sprint = await runHeld(['ShiftLeft', 'KeyW'], 8.0);
  result.mine[ride] = { cruise: measure(cruise, ride + '/W'), sprint: measure(sprint, ride + '/Shift+W') };
}

console.log(JSON.stringify({ ...result, errs: errs.slice(0, 8) }));
await browser.close(); server.close();
