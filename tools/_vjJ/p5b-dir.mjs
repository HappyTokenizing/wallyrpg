/* p5b — WHICH WAY IS FORWARD, measured, plus the rungs p5's window was
   too strict (or the runway too short) to hold.

   My first direction test was wrong and it is worth writing down why:
   I set his yaw to 0, held W for a second, and read dx +5.34 / dz -1.31
   — which looks like "forward is +x". It is not. W is a CAMERA-relative
   wish (camera.js: controller.input is a world direction), so holding W
   turns him to face the camera's forward and then drives him along it;
   the yaw I set was gone within three frames. The convention under test
   is about HIS frame, so it has to be measured in his frame: the step
   he takes, projected on his own +z. */
import { boot, unwrapSum } from './lib.mjs';
const TAU = Math.PI * 2;
const { page, browser, server, errs } = await boot({ w: 900, h: 560, query: '?skipIntro&touch=1' });
const RUNWAY = { x: 332.55, z: -253.73, yaw: -1.571 };

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
    const V = new T.Vector3();
    const lc = (o) => { o.getWorldPosition(V); w.root.worldToLocal(V); return [V.x, V.y, V.z]; };
    rows.push({ t: c.elapsed, x: p.x, z: p.z, yaw: w.root.rotation.y, spd: ct.planarSpeed,
      fwd: [f.x, f.z], odo: b.odometer, wrot: b.wheels.map((k) => k.rotation.x), wr: b.wheels.map((k) => k.position.y),
      crot: b.crank ? b.crank.rotation.x : null,
      ankL: lc(w.bones.footL),
      pedalL: (() => { if (!b.crank) return null; const arm = b.crank.children.find((k) => k.isGroup && k.position.x > 0); if (!arm) return null; const pl = arm.children.find((k) => k.isMesh && k.geometry && k.geometry.type === 'BoxGeometry'); return pl ? lc(pl) : null; })(),
      rimR: (() => { const re = b.wheels.find((k) => k.position.z < 0) || b.wheels[0]; V.set(0, re.position.y, 0); re.localToWorld(V); w.root.worldToLocal(V); return [V.x, V.y, V.z]; })() });
  } });
});

async function mount(r) { await page.evaluate((x) => { const c = window.WALLY.ctx; c.game.actions.grantRide(x); c.game.actions.equipRide(x); }, r); await page.waitForTimeout(2500); }
async function reset() {
  await page.evaluate((q) => { const c = window.WALLY.ctx; c.wally.setPosition(q.x, c.world.heightAt(q.x, q.z), q.z); c.wally.setYaw(q.yaw); c.wally.controller.velocity.set(0, 0, 0); }, RUNWAY);
  await page.waitForTimeout(1500);
}
async function held(keys, secs) {
  await page.evaluate(() => window.__S.start());
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(secs * 1000);
  const rows = await page.evaluate(() => window.__S.stop());
  for (const k of keys) await page.keyboard.up(k);
  await page.waitForTimeout(800);
  return rows;
}
async function stick(want, secs) {
  const g = await page.evaluate(() => {
    const t = window.WALLY.ctx.ui.touch, z = document.querySelector('.w-stickzone');
    const r = z ? z.getBoundingClientRect() : null, o = window.WALLY.ctx.wally.controller.opts;
    return { R: t && t.axes ? t.axes.R : null, rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null, walk: o.walkSpeed, run: o.runSpeed };
  });
  const DEAD = 0.12, RUN_AT = 0.62;
  const t = want <= g.walk ? RUN_AT * (want / g.walk) : RUN_AT + (1 - RUN_AT) * ((want - g.walk) / (g.run - g.walk));
  const len = (DEAD + t * (1 - DEAD)) * g.R;
  const cx = g.rect.x + Math.min(g.rect.w * 0.5, 110), cy = g.rect.y + g.rect.h - 110;
  await page.mouse.move(cx, cy); await page.mouse.down();
  await page.mouse.move(cx, cy - 2); await page.mouse.move(cx, cy - len * 0.5); await page.mouse.move(cx, cy - len);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__S.start());
  await page.waitForTimeout(secs * 1000);
  const rows = await page.evaluate(() => window.__S.stop());
  await page.mouse.up(); await page.waitForTimeout(800);
  return rows;
}

function measure(rows, label, want, tol = 0.004) {
  if (!rows || rows.length < 30) return { label, err: 'no rows' };
  const sp = rows.map((r) => r.spd);
  const top = sp.slice().sort((a, b) => b - a)[Math.floor(rows.length * 0.05)];
  let bi = 0, bl = 0, i = 0;
  while (i < rows.length) {
    if (Math.abs(sp[i] - top) <= top * tol) { let j = i; while (j < rows.length && Math.abs(sp[j] - top) <= top * tol) j++; if (j - i > bl) { bl = j - i; bi = i; } i = j; } else i++;
  }
  const R = rows.slice(bi, bi + bl);
  if (R.length < 25) return { label, err: 'never settled', top: +top.toFixed(3), best: bl };
  let path = 0, fwd = 0;
  for (let k = 1; k < R.length; k++) {
    const dx = R[k].x - R[k - 1].x, dz = R[k].z - R[k - 1].z;
    path += Math.hypot(dx, dz); fwd += dx * R[k - 1].fwd[0] + dz * R[k - 1].fwd[1];
  }
  const odo = R[R.length - 1].odo - R[0].odo;
  const o = { label, wanted: want, n: R.length, cruise: +top.toFixed(4), seconds: +(R[R.length - 1].t - R[0].t).toFixed(2),
    pathM: +path.toFixed(4), forwardM: +fwd.toFixed(4), odoM: +odo.toFixed(4),
    fwdFracOfPath: +(fwd / path).toFixed(6),
    odoVsPathPct: +(((odo / path) - 1) * 100).toFixed(3), wheels: [] };
  for (let k = 0; k < R[0].wrot.length; k++) {
    const rad = unwrapSum(R.map((r) => r.wrot[k])), rr = R[0].wr[k], revs = rad / TAU, dem = 1 / (TAU * rr);
    let back = 0;
    for (let q = 1; q < R.length; q++) { let d = R[q].wrot[k] - R[q - 1].wrot[k]; d -= Math.round(d / TAU) * TAU; if (d < back) back = d; }
    o.wheels.push({ k, R: +rr.toFixed(4), demandRevPerM: +dem.toFixed(6),
      vsOdoErrPct: +(((revs / odo) / dem - 1) * 100).toFixed(4),
      vsPathErrPct: +(((revs / path) / dem - 1) * 100).toFixed(3), maxBackStepRad: +back.toFixed(5) });
  }
  if (R[0].crot != null) {
    o.metresPerCrankRev = +(path / (unwrapSum(R.map((r) => r.crot)) / TAU)).toFixed(4);
    let ti = 0; for (let q = 1; q < R.length - 1; q++) if (R[q].ankL[1] > R[ti].ankL[1]) ti = q;
    o.ankleDzAtTop = +(R[ti + 1].ankL[2] - R[ti].ankL[2]).toFixed(5);
    let pi2 = 0; for (let q = 1; q < R.length - 1; q++) if (R[q].pedalL[1] > R[pi2].pedalL[1]) pi2 = q;
    o.pedalDzAtTop = +(R[pi2 + 1].pedalL[2] - R[pi2].pedalL[2]).toFixed(5);
  }
  let ri = 0; for (let q = 1; q < R.length - 1; q++) if (R[q].rimR[1] > R[ri].rimR[1]) ri = q;
  o.rimDzAtTop = +(R[ri + 1].rimR[2] - R[ri].rimR[2]).toFixed(5);
  return o;
}

const out = {};
await mount('bike');
await reset();
/* ---- the convention, in HIS frame ---- */
{
  const rows = await held(['KeyW'], 3.0);
  const R = rows.slice(Math.floor(rows.length * 0.5));
  let fwd = 0, path = 0, dz = 0, dx = 0;
  for (let k = 1; k < R.length; k++) {
    const ax = R[k].x - R[k - 1].x, az = R[k].z - R[k - 1].z;
    path += Math.hypot(ax, az); fwd += ax * R[k - 1].fwd[0] + az * R[k - 1].fwd[1]; dx += ax; dz += az;
  }
  const f0 = R[0].fwd, y0 = R[0].yaw;
  out.direction = {
    heldKey: 'W', seconds: +(R[R.length - 1].t - R[0].t).toFixed(2),
    worldDx: +dx.toFixed(3), worldDz: +dz.toFixed(3),
    settledYaw: +y0.toFixed(4), rootForwardWorld: [+f0[0].toFixed(4), +f0[1].toFixed(4)],
    travelAlongOwnPlusZ: +fwd.toFixed(3), pathLength: +path.toFixed(3),
    fractionOfPathAlongOwnPlusZ: +(fwd / path).toFixed(5),
    /* three.js fact, checked rather than recited: the +z basis vector of
       a yaw-only quaternion is (sin yaw, cos yaw) */
    forwardMatchesSinCosYaw: Math.abs(f0[0] - Math.sin(y0)) < 1e-6 && Math.abs(f0[1] - Math.cos(y0)) < 1e-6,
  };
}

/* ---- the rungs p5 could not hold ---- */
out.rungs = [];
const TODO = [
  { ride: 'bike', v: 8.2, how: 'stick', secs: 6 },
  { ride: 'bike', v: 5.1, how: 'key', secs: 8 },
  { ride: 'bike', v: 8.8, how: 'run', secs: 6 },
  { ride: 'motorcycle', v: 15.3, how: 'key', secs: 4 },
  { ride: 'motorcycle', v: 22.0, how: 'stick', secs: 3.2 },
  { ride: 'motorcycle', v: 26.4, how: 'run', secs: 3.0 },
];
let cur = 'bike';
for (const t of TODO) {
  if (t.ride !== cur) { await mount(t.ride); cur = t.ride; }
  await reset();
  const rows = t.how === 'key' ? await held(['KeyW'], t.secs)
    : t.how === 'run' ? await held(['ShiftLeft', 'KeyW'], t.secs)
      : await stick(t.v, t.secs);
  out.rungs.push(measure(rows, `${t.ride}@${t.v}/${t.how}`, t.v));
}
console.log(JSON.stringify({ ...out, errs: errs.slice(0, 6) }, null, 1));
await browser.close(); server.close();
