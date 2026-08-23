/* _pj/look.mjs — (a) painted-below-design on the GAMEPLAY props,
   (b) the top rungs at road spots spread across the island,
   (c) screenshots of the worst road stand SINK and the worst road
       HOVER the census found, because millimetres are not a substitute
       for looking at the thing. */
import { boot } from './lib.mjs';
const { page, errs, close } = await boot();

const A = await page.evaluate(() => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const out = [];
  for (const key of ['bike', 'scooter', 'motorcycle']) {
    W.debug.parkProbe(0, 0, 0, key, true);
    const p = c.wally.rideProps[key]; if (!p) { out.push({ key, error: 'none' }); continue; }
    const g = p.group;
    const keepR = g.rotation.clone(), keepP = g.position.clone();
    g.position.set(0, 0, 0); g.rotation.order = 'YXZ'; g.rotation.set(0, 0, p.parkLean);
    g.updateMatrixWorld(true);
    let st = null; g.traverse((o) => { if (o.name === 'kickstand') st = o; });
    let painted = null;
    if (st) { st.updateMatrixWorld(true);
      const pos = st.geometry.attributes.position, v = new T.Vector3(); let lo = Infinity;
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(st.matrixWorld); if (v.y < lo) lo = v.y; }
      painted = lo; }
    let design = null;
    if (p.standFoot) design = new T.Vector3(p.standFoot.x, p.standFoot.y, p.standFoot.z).applyMatrix4(g.matrixWorld).y;
    out.push({ key, leanDeg: +(p.parkLean * 180 / Math.PI).toFixed(2),
      paintedBelowDesignMM: (painted != null && design != null) ? +((design - painted) * 1000).toFixed(2) : null });
    g.position.copy(keepP); g.rotation.copy(keepR); g.updateMatrixWorld(true);
  }
  return out;
});
console.log('STANDOFFSET ' + JSON.stringify(A));

const B = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx, b = c.world.bounds;
  /* road spots, spread: take every Nth road hit across the whole box */
  const road = [];
  for (let x = b.min.x + 13; x <= b.max.x; x += 17.3)
    for (let z = b.min.z + 7; z <= b.max.z; z += 19.7) {
      const h = c.world.heightAt(x, z);
      if (!Number.isFinite(h) || h < c.world.seaLevel + 0.3) continue;
      if (c.world.isRoad(x, z)) road.push({ x, z, y: h });
    }
  const step = Math.max(1, Math.floor(road.length / 40));
  const spread = road.filter((_, i) => i % step === 0).slice(0, 40);
  const rows = [];
  for (const [ride, rung] of [['bike', 8.8], ['scooter', 13.2], ['motorcycle', 15.3], ['motorcycle', 26.4]]) {
    let best = null, tried = 0;
    for (const s of spread) {
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        c.wally.setPosition(s.x, s.y, s.z); c.wally.setYaw(yaw);
        const t = W.debug.driveTrace(ride, rung, 48); tried++;
        const row = { ride, rung, at: [+s.x.toFixed(0), +s.z.toFixed(0)], yaw: +yaw.toFixed(2),
          blocked: t.travelBlocked, cruise: t.sampledAtCruise, measured: t.rungMeasured, target: t.rungTarget,
          demand: t.revPerMetreDemanded, deliver: t.revPerMetreDelivered, errPct: t.wheelRateErrPct,
          dirs: [t.driveDirection.ankle, t.driveDirection.pedal, t.driveDirection.wheelMark],
          cross: t.wheelRollVsTravel, back: t.maxBackwardStepRad, trend: t.sampleTrendPct };
        if (!t.travelBlocked && t.sampledAtCruise) { best = row; break; }
        if (!best || (best.measured < row.measured)) best = row;
      }
      if (best && !best.blocked && best.cruise) break;
    }
    best.tried = tried;
    rows.push(best);
  }
  return rows;
});
console.log('RUNGS ' + JSON.stringify(B, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 5));
await close();
