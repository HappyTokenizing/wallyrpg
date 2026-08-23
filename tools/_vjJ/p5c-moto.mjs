/* p5c — the motorcycle's top two rungs need a longer runway than the
   120 m one: at 26.4 m/s it eats that in under five seconds, which is
   why p5b could not hold a steady window there. Find 300 m of clear
   ground first, then measure. */
import { boot, unwrapSum } from './lib.mjs';
const TAU = Math.PI * 2;
const { page, browser, server, errs } = await boot({ w: 800, h: 500, query: '?skipIntro&touch=1' });
await page.evaluate(() => { const c = window.WALLY.ctx; c.game.actions.grantRide('motorcycle'); c.game.actions.equipRide('motorcycle'); });
await page.waitForTimeout(2600);

await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const rows = [];
  window.__S = { rows, on: false, start() { rows.length = 0; this.on = true; }, stop() { this.on = false; return rows; } };
  c._handles.push({ lateUpdate() {
    if (!window.__S.on) return;
    const w = c.wally, b = w.bike, ct = w.controller; if (!b || !ct) return;
    const f = new T.Vector3(0, 0, 1).applyQuaternion(w.root.quaternion);
    const V = new T.Vector3();
    const re = b.wheels.find((k) => k.position.z < 0) || b.wheels[0];
    V.set(0, re.position.y, 0); re.localToWorld(V); w.root.worldToLocal(V);
    rows.push({ t: c.elapsed, x: ct.simPosition.x, z: ct.simPosition.z, spd: ct.planarSpeed,
      fwd: [f.x, f.z], odo: b.odometer, wrot: b.wheels.map((k) => k.rotation.x), wr: b.wheels.map((k) => k.position.y),
      rim: [V.x, V.y, V.z] });
  } });
});

const site = { x: 332.55, z: -253.73, yaw: -1.571, clear: 120, note: 'the p4b runway, chosen by driving it' };
const _unused = async () => await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : NaN; } catch (e) { return NaN; } };
  let best = null;
  for (let i = 0; i < 3000; i++) {
    const x = (Math.random() * 2 - 1) * 430, z = (Math.random() * 2 - 1) * 430;
    const h = H(x, z); if (!(h > 2)) continue;
    const yaw = Math.random() * Math.PI * 2;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    let d = 0;
    for (; d <= 340; d += 4) { const hh = H(x + fx * d, z + fz * d); if (!(hh > 1.5) || Math.abs(hh - h) > 8) break; }
    if (!best || d > best.clear) best = { x: +x.toFixed(2), z: +z.toFixed(2), yaw: +yaw.toFixed(4), clear: d };
  }
  return best;
});

async function reset() {
  await page.evaluate((q) => { const c = window.WALLY.ctx; c.wally.setPosition(q.x, c.world.heightAt(q.x, q.z), q.z); c.wally.setYaw(q.yaw); c.wally.controller.velocity.set(0, 0, 0); }, site);
  await page.waitForTimeout(1600);
}
function measure(rows, label, tol = 0.004) {
  const sp = rows.map((r) => r.spd);
  const top = sp.slice().sort((a, b) => b - a)[Math.floor(rows.length * 0.05)];
  let bi = 0, bl = 0, i = 0;
  while (i < rows.length) { if (Math.abs(sp[i] - top) <= top * tol) { let j = i; while (j < rows.length && Math.abs(sp[j] - top) <= top * tol) j++; if (j - i > bl) { bl = j - i; bi = i; } i = j; } else i++; }
  const R = rows.slice(bi, bi + bl);
  if (R.length < 25) return { label, err: 'never settled', top: +top.toFixed(3), best: bl };
  let path = 0, fwd = 0;
  for (let k = 1; k < R.length; k++) { const dx = R[k].x - R[k - 1].x, dz = R[k].z - R[k - 1].z; path += Math.hypot(dx, dz); fwd += dx * R[k - 1].fwd[0] + dz * R[k - 1].fwd[1]; }
  const odo = R[R.length - 1].odo - R[0].odo;
  const o = { label, n: R.length, cruise: +top.toFixed(4), seconds: +(R[R.length - 1].t - R[0].t).toFixed(2),
    pathM: +path.toFixed(3), forwardM: +fwd.toFixed(3), odoM: +odo.toFixed(3), odoVsPathPct: +(((odo / path) - 1) * 100).toFixed(3), wheels: [] };
  for (let k = 0; k < R[0].wrot.length; k++) {
    const revs = unwrapSum(R.map((r) => r.wrot[k])) / TAU, rr = R[0].wr[k], dem = 1 / (TAU * rr);
    let back = 0; for (let q = 1; q < R.length; q++) { let d = R[q].wrot[k] - R[q - 1].wrot[k]; d -= Math.round(d / TAU) * TAU; if (d < back) back = d; }
    o.wheels.push({ k, R: +rr.toFixed(4), demandRevPerM: +dem.toFixed(6), vsOdoErrPct: +(((revs / odo) / dem - 1) * 100).toFixed(4), vsPathErrPct: +(((revs / path) / dem - 1) * 100).toFixed(3), maxBackStepRad: +back.toFixed(5) });
  }
  let ri = 0; for (let q = 1; q < R.length - 1; q++) if (R[q].rim[1] > R[ri].rim[1]) ri = q;
  o.rimDzAtTop = +(R[ri + 1].rim[2] - R[ri].rim[2]).toFixed(5);
  return o;
}
async function held(keys, secs) {
  await page.evaluate(() => window.__S.start());
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(secs * 1000);
  const rows = await page.evaluate(() => window.__S.stop());
  for (const k of keys) await page.keyboard.up(k);
  await page.waitForTimeout(700);
  return rows;
}
async function stick(want, secs) {
  const g = await page.evaluate(() => { const t = window.WALLY.ctx.ui.touch, z = document.querySelector('.w-stickzone'); const r = z.getBoundingClientRect(), o = window.WALLY.ctx.wally.controller.opts; return { R: t.axes.R, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, walk: o.walkSpeed, run: o.runSpeed }; });
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
  await page.mouse.up(); await page.waitForTimeout(700);
  return rows;
}
const out = { site, runs: [] };
await reset(); out.runs.push(measure(await held(['KeyW'], 6), 'moto@15.3/key'));
await reset(); out.runs.push(measure(await stick(22.0, 4.2), 'moto@22/stick', 0.006));
await reset(); out.runs.push(measure(await held(['ShiftLeft', 'KeyW'], 4.0), 'moto@26.4/run', 0.006));
console.log(JSON.stringify({ ...out, errs: errs.slice(0, 5) }, null, 1));
await browser.close(); server.close();
