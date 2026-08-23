/* TWO (and three) MACHINES PARKED WITHOUT MOVING A STEP, and the
   pedal-less drivetrain rule. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ wait: 4000 });

/* pin him where he stands for the whole of a dismount */
await page.evaluate(() => {
  const W = window.WALLY;
  window.__HOLD = (x, y, z, yaw) => {
    if (window.__H) cancelAnimationFrame(window.__H);
    const t = () => { W.ctx.wally.setPosition(x, y, z); W.ctx.wally.setYaw(yaw); window.__H = requestAnimationFrame(t); };
    t();
  };
  window.__RELEASE = () => { if (window.__H) cancelAnimationFrame(window.__H); window.__H = null; };
});

const spot = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const p = c.wally.root.position;
  const h = c.world.heightAt(p.x, p.z);
  window.__SPOT = { x: p.x, y: Number.isFinite(h) ? h : p.y, z: p.z, yaw: c.wally.root.rotation.y };
  window.__HOLD(window.__SPOT.x, window.__SPOT.y, window.__SPOT.z, window.__SPOT.yaw);
  return window.__SPOT;
});
P('SPOT', spot);

for (const id of ['bike', 'scooter', 'motorcycle']) {
  await page.evaluate((i) => { window.WALLY.debug.giveRide(i); }, id);
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.WALLY.ctx.game.actions.equipRide(null); });
  await page.waitForTimeout(900);
  const st = await page.evaluate(() => window.WALLY.ctx.wally.bikeState.parked);
  P('AFTER-' + id, st);
}

const geom = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx, T = W.THREE;
  const ids = ['bike', 'scooter', 'motorcycle'];
  const boxes = {}, pos = {};
  for (const id of ids) {
    const p = c.wally.rideProps[id]; if (!p) continue;
    p.group.updateMatrixWorld(true);
    const b = new T.Box3().setFromObject(p.group);
    boxes[id] = [b.min.toArray().map((v) => +v.toFixed(3)), b.max.toArray().map((v) => +v.toFixed(3))];
    pos[id] = p.group.position.toArray().map((v) => +v.toFixed(3));
  }
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = boxes[ids[i]], b = boxes[ids[j]];
      if (!a || !b) continue;
      const ovl = [0, 1, 2].map((k) => Math.min(a[1][k], b[1][k]) - Math.max(a[0][k], b[0][k]));
      pairs.push({ pair: ids[i] + '/' + ids[j],
        centreDist: +Math.hypot(pos[ids[i]][0] - pos[ids[j]][0], pos[ids[i]][2] - pos[ids[j]][2]).toFixed(3),
        aabbOverlapXYZ: ovl.map((v) => +v.toFixed(3)),
        interpenetrates: ovl.every((v) => v > 0) });
    }
  }
  const r = c.wally.root.position;
  const offs = {};
  for (const id of ids) if (pos[id]) {
    const dx = pos[id][0] - r.x, dz = pos[id][2] - r.z;
    const yaw = c.wally.root.rotation.y;
    offs[id] = +(dx * Math.cos(yaw) - dz * Math.sin(yaw)).toFixed(3);   // along local +x
  }
  return { pos, riderAt: [+r.x.toFixed(3), +r.z.toFixed(3)], localOffsetX: offs, pairs };
});
P('THREE-PARKED', geom);
await page.evaluate(() => { window.__RELEASE(); });

/* ---- the pedal-less drivetrain rule ---- */
for (const ride of ['bike', 'scooter', 'motorcycle']) {
  const d = await page.evaluate((r) => {
    const t = window.WALLY.debug.driveTrace(r, undefined, 48);
    return { ride: t.ride, dzAtTop: t.dzAtTop, dir: t.driveDirection, floor: t.dzNoiseFloorM,
      crankTurnsPerCycle: t.crankTurnsPerCycle, fitMaxMM: t.fitMaxMM, fitDriftMM: t.fitDriftMM,
      fitMinMM: t.fitMinMM, meanOffsetMM: t.meanOffsetMM };
  }, ride);
  P('DRIVEDIR', d);
}
P('ERRS', errs.slice(0, 8));
await close();
