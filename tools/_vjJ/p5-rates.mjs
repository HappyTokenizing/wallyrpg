/* p5 — DEMANDED vs DELIVERED at every rung, and the direction of travel
   measured rather than assumed.

   Rungs the keyboard cannot ask for are held on the REAL touch
   thumbstick, at the deflection whose analogue speed is that rung
   (touch.js: t = (u-DEAD)/(1-DEAD), speed = walk*(t/RUN_AT) below
   RUN_AT and walk+(run-walk)*((t-RUN_AT)/(1-RUN_AT)) above).

   Distance is taken three ways so a disagreement can be located:
     path      sum of |dp| in xz, the ground truth
     forward   the same steps projected on his own +z
     odometer  the prop's own accumulator
   and the wheel is compared against each. */
import { boot, unwrapSum } from './lib.mjs';
const TAU = Math.PI * 2;
const { page, browser, server, errs } = await boot({ w: 900, h: 560, query: '?skipIntro&touch=1' });

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
    rows.push({ t: c.elapsed, x: p.x, y: p.y, z: p.z, wx: w.root.position.x, wz: w.root.position.z,
      spd: ct.planarSpeed, fwd: [f.x, f.z], odo: b.odometer,
      wrot: b.wheels.map((k) => k.rotation.x), wr: b.wheels.map((k) => k.position.y),
      crot: b.crank ? b.crank.rotation.x : null,
      clipA: w.animator && w.animator._bkA && w.animator._bkA.name, clipB: w.animator && w.animator._bkB && w.animator._bkB.name, bkF: w.animator && w.animator._bkF,
      ankL: lc(w.bones.footL), ankR: lc(w.bones.footR),
      pedalL: (() => { if (!b.crank) return null; const arm = b.crank.children.find((k) => k.isGroup && k.position.x > 0); if (!arm) return null; const pl = arm.children.find((k) => k.isMesh && k.geometry && k.geometry.type === 'BoxGeometry'); return pl ? lc(pl) : null; })(),
      rimR: (() => { const re = b.wheels.find((k) => k.position.z < 0) || b.wheels[0]; V.set(0, re.position.y, 0); re.localToWorld(V); w.root.worldToLocal(V); return [V.x, V.y, V.z]; })() });
  } });
});

const RUNWAY = { x: 332.55, z: -253.73, yaw: -1.571 };
async function reset(yaw) {
  await page.evaluate((q) => {
    const c = window.WALLY.ctx;
    c.wally.setPosition(q.x, c.world.heightAt(q.x, q.z), q.z);
    c.wally.setYaw(q.yaw);
    if (c.wally.controller) c.wally.controller.velocity.set(0, 0, 0);
  }, { ...RUNWAY, yaw: yaw == null ? RUNWAY.yaw : yaw });
  await page.waitForTimeout(1500);
}
async function mount(ride) {
  await page.evaluate((r) => { const c = window.WALLY.ctx; c.game.actions.grantRide(r); c.game.actions.equipRide(r); }, ride);
  await page.waitForTimeout(2600);
}

function measure(rows, label, want) {
  if (!rows || rows.length < 30) return { label, err: 'no rows', n: rows ? rows.length : 0 };
  const sp = rows.map((r) => r.spd);
  const top = sp.slice().sort((a, b) => b - a)[Math.floor(rows.length * 0.05)];
  let bi = 0, bl = 0, i = 0;
  while (i < rows.length) {
    if (Math.abs(sp[i] - top) <= top * 0.002) { let j = i; while (j < rows.length && Math.abs(sp[j] - top) <= top * 0.002) j++; if (j - i > bl) { bl = j - i; bi = i; } i = j; } else i++;
  }
  const R = rows.slice(bi, bi + bl);
  if (R.length < 25) return { label, err: 'never settled', top: +top.toFixed(3), best: bl };
  let path = 0, fwd = 0;
  for (let k = 1; k < R.length; k++) {
    const dx = R[k].x - R[k - 1].x, dz = R[k].z - R[k - 1].z;
    path += Math.hypot(dx, dz);
    fwd += dx * R[k - 1].fwd[0] + dz * R[k - 1].fwd[1];
  }
  const odo = R[R.length - 1].odo - R[0].odo;
  const out = { label, wanted: want, n: R.length, cruise: +top.toFixed(4),
    clip: R[0].clipA + '->' + R[0].clipB + '@' + (R[0].bkF == null ? '?' : R[0].bkF.toFixed(2)),
    pathM: +path.toFixed(4), forwardM: +fwd.toFixed(4), odoM: +odo.toFixed(4),
    odoVsPathPct: +(((odo / path) - 1) * 100).toFixed(4),
    odoVsForwardPct: +(((odo / fwd) - 1) * 100).toFixed(4), wheels: [] };
  for (let k = 0; k < R[0].wrot.length; k++) {
    const rad = unwrapSum(R.map((r) => r.wrot[k]));
    const rr = R[0].wr[k], revs = rad / TAU, dem = 1 / (TAU * rr);
    let back = 0;
    for (let q = 1; q < R.length; q++) { let d = R[q].wrot[k] - R[q - 1].wrot[k]; d -= Math.round(d / TAU) * TAU; if (d < back) back = d; }
    out.wheels.push({ k, R: +rr.toFixed(4), revs: +revs.toFixed(4), demandRevPerM: +dem.toFixed(6),
      vsOdo: +(revs / odo).toFixed(6), vsOdoErrPct: +(((revs / odo) / dem - 1) * 100).toFixed(4),
      vsPath: +(revs / path).toFixed(6), vsPathErrPct: +(((revs / path) / dem - 1) * 100).toFixed(4),
      vsForwardErrPct: +(((revs / fwd) / dem - 1) * 100).toFixed(4), maxBackStepRad: +back.toFixed(5) });
  }
  if (R[0].crot != null) {
    const cr = unwrapSum(R.map((r) => r.crot));
    out.crankRevs = +(cr / TAU).toFixed(4);
    out.metresPerCrankRev = +(path / (cr / TAU)).toFixed(4);
    /* the ankle's OWN circle, from the ankle, not from a published phase */
    let ti = 0; for (let q = 1; q < R.length - 1; q++) if (R[q].ankL[1] > R[ti].ankL[1]) ti = q;
    out.ankleDzAtTop = +(R[ti + 1].ankL[2] - R[ti].ankL[2]).toFixed(5);
    let pi = 0; for (let q = 1; q < R.length - 1; q++) if (R[q].pedalL && R[q].pedalL[1] > R[pi].pedalL[1]) pi = q;
    out.pedalDzAtTop = R[pi].pedalL ? +(R[pi + 1].pedalL[2] - R[pi].pedalL[2]).toFixed(5) : null;
  }
  let ri = 0; for (let q = 1; q < R.length - 1; q++) if (R[q].rimR[1] > R[ri].rimR[1]) ri = q;
  out.rimDzAtTop = +(R[ri + 1].rimR[2] - R[ri].rimR[2]).toFixed(5);
  return out;
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

/* the real thumbstick, held at the deflection that asks for `want` */
async function stick(want, secs) {
  const g = await page.evaluate(() => {
    const t = window.WALLY.ctx.ui && window.WALLY.ctx.ui.touch;
    const z = document.querySelector('.w-stickzone');
    const r = z ? z.getBoundingClientRect() : null;
    const o = window.WALLY.ctx.wally.controller.opts;
    return { R: t && t.axes ? t.axes.R : null, rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null, walk: o.walkSpeed, run: o.runSpeed };
  });
  if (!g.rect || !g.R) return { rows: null, geo: g };
  const DEAD = 0.12, RUN_AT = 0.62;
  const t = want <= g.walk ? RUN_AT * (want / g.walk) : RUN_AT + (1 - RUN_AT) * ((want - g.walk) / (g.run - g.walk));
  const u = DEAD + t * (1 - DEAD);
  const len = u * g.R;
  const cx = g.rect.x + Math.min(g.rect.w * 0.5, 110), cy = g.rect.y + g.rect.h - 110;
  await page.mouse.move(cx, cy); await page.mouse.down();
  await page.mouse.move(cx, cy - 2);
  await page.mouse.move(cx, cy - len * 0.5);
  await page.mouse.move(cx, cy - len);
  await page.waitForTimeout(400);
  const reads = await page.evaluate(() => { const t2 = window.WALLY.ctx.ui.touch; return t2 && t2.axes ? t2.axes : null; });
  await page.evaluate(() => window.__S.start());
  await page.waitForTimeout(secs * 1000);
  const rows = await page.evaluate(() => window.__S.stop());
  await page.mouse.up();
  await page.waitForTimeout(900);
  return { rows, geo: g, stickReads: reads, askedT: +t.toFixed(3), pixels: +len.toFixed(1) };
}

const out = { dir: null, rungs: {} };

/* ---- WHICH WAY IS FORWARD. Held W with yaw 0, in the world. ---- */
await mount('bike');
await reset(0);
{
  const p0 = await page.evaluate(() => { const p = window.WALLY.ctx.wally.root.position; return [p.x, p.y, p.z]; });
  await page.keyboard.down('KeyW'); await page.waitForTimeout(1000); await page.keyboard.up('KeyW');
  await page.waitForTimeout(600);
  const p1 = await page.evaluate(() => { const p = window.WALLY.ctx.wally.root.position; return [p.x, p.y, p.z]; });
  out.dir = { yaw: 0, dx: +(p1[0] - p0[0]).toFixed(3), dz: +(p1[2] - p0[2]).toFixed(3) };
}

const LADDER = {
  bike: [{ v: 3.4, how: 'stick' }, { v: 5.1, how: 'key' }, { v: 8.2, how: 'stick' }, { v: 8.8, how: 'run' }],
  scooter: [{ v: 4.6, how: 'stick' }, { v: 7.65, how: 'key' }, { v: 12.6, how: 'stick' }, { v: 13.2, how: 'run' }],
  motorcycle: [{ v: 8.0, how: 'stick' }, { v: 15.3, how: 'key' }, { v: 22.0, how: 'stick' }, { v: 26.4, how: 'run' }],
};
for (const ride of Object.keys(LADDER)) {
  await mount(ride);
  out.rungs[ride] = [];
  for (const r of LADDER[ride]) {
    await reset();
    let rows = null, meta = null;
    if (r.how === 'key') rows = await held(['KeyW'], 6);
    else if (r.how === 'run') rows = await held(['ShiftLeft', 'KeyW'], 6);
    else { const s = await stick(r.v, 6); rows = s.rows; meta = { askedT: s.askedT, pixels: s.pixels, stickReads: s.stickReads }; }
    out.rungs[ride].push({ ...measure(rows, `${ride}@${r.v}/${r.how}`, r.v), meta });
  }
}
console.log(JSON.stringify({ ...out, errs: errs.slice(0, 8) }));
await browser.close(); server.close();
