/* _pj/rates2.mjs — the independent direction ruler, ALIAS-PROOF.

   My first version held Shift+W and differenced wheel.rotation.x frame
   to frame through an unwrap to (-pi, pi]. Headless renders at ~29 fps,
   and the motorcycle at its 26.4 m/s run rung turns 3.37 rad per frame
   — MORE THAN pi — so the unwrap folded it the wrong way and the tool
   reported -5.16 revolutions on 23.4 m of forward travel. That is a
   reversed drivetrain, reported by the ruler, on a drivetrain that is
   exact. Same failure as every other one in this file's history: the
   instrument sampled a case it could not resolve.

   So: record RAW per-frame rotation and speed, publish rad/frame, and
   read the direction only from frames where the step is well under pi.
   Every machine passes through those frames on the way up from a
   standstill, so the population is never empty. */
import { boot } from './lib.mjs';
const { page, errs, close } = await boot();
const B = [];
for (const ride of ['bike', 'scooter', 'motorcycle']) {
  await page.evaluate((r) => { const a = window.WALLY.ctx.game.actions; a.equipRide(null); a.grantRide(r); a.equipRide(r); }, ride);
  await page.waitForTimeout(1800);
  const start = await page.evaluate(() => { window.__PJ = { frames: [], on: true };
    const W = window.WALLY, T = W.THREE, c = W.ctx;
    return true; });
  await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW');
  const r = await page.evaluate(async (rd) => {
    const W = window.WALLY, T = W.THREE, c = W.ctx;
    const p = c.wally.rideProps[rd];
    const g = p.group, wheel = (p.wheels || [])[1] || (p.wheels || [])[0];
    const root = c.wally.root, TAU = Math.PI * 2;
    const wr = Math.abs(wheel.position.y);
    const wrap = (d) => d - Math.round(d / TAU) * TAU;
    let prevRot = wheel.rotation.x;
    const prev = root.position.clone();
    const mark = new T.Vector3();
    const rows = [];
    const t0 = performance.now();
    for (let i = 0; i < 140; i++) {
      await new Promise((res) => requestAnimationFrame(res));
      root.updateMatrixWorld(true); wheel.updateMatrixWorld(true);
      const d = wrap(wheel.rotation.x - prevRot); prevRot = wheel.rotation.x;
      const dx = root.position.x - prev.x, dz = root.position.z - prev.z;
      prev.copy(root.position);
      const fwd = new T.Vector3(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
      const step = dx * fwd.x + dz * fwd.z;
      mark.set(0, wr, 0).applyMatrix4(wheel.matrixWorld); root.worldToLocal(mark);
      rows.push({ d, step, my: mark.y, mz: mark.z });
    }
    const secs = (performance.now() - t0) / 1000;
    const CLEAN = 1.0;   // rad per frame; pi is the alias limit, this is 3x under it
    const clean = rows.filter((r2) => Math.abs(r2.d) < CLEAN && Math.abs(r2.step) > 0.005);
    const revs = clean.reduce((s, r2) => s + r2.d, 0) / TAU;
    const dist = clean.reduce((s, r2) => s + Math.abs(r2.step), 0);
    /* the valve stem at the top of its circle, restricted to the clean
       frames so the chord is a real chord */
    let bi = -1;
    for (let i = 0; i < rows.length - 1; i++) {
      if (Math.abs(rows[i].d) > CLEAN || Math.abs(rows[i + 1].d) > CLEAN) continue;
      if (bi < 0 || rows[i].my > rows[bi].my) bi = i;
    }
    return { ride: rd, fps: +(rows.length / secs).toFixed(1),
      wheelRadius: +wr.toFixed(4), frames: rows.length,
      maxRadPerFrame: +Math.max(...rows.map((r2) => Math.abs(r2.d))).toFixed(3),
      aliasedFrames: rows.filter((r2) => Math.abs(r2.d) > Math.PI * 0.9).length,
      cleanFrames: clean.length,
      cleanDistance: +dist.toFixed(4), cleanRevs: +revs.toFixed(4),
      revPerMetreDelivered: dist > 0.05 ? +(revs / dist).toFixed(4) : null,
      revPerMetreDemanded: +(1 / (TAU * wr)).toFixed(4),
      travelSign: Math.sign(clean.reduce((s, r2) => s + r2.step, 0)),
      wheelSign: Math.sign(revs),
      markDzAtTopCleanMM: bi >= 0 ? +((rows[bi + 1].mz - rows[bi].mz) * 1000).toFixed(2) : null };
  }, ride);
  await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
  await page.waitForTimeout(500);
  B.push(r);
  console.log(JSON.stringify(r));
}
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
