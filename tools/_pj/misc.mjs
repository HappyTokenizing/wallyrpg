/* _pj/misc.mjs — (1) the painted-vs-design stand offset in each prop's
   OWN frame at its own lean, (2) the fit figures, (3) the top rungs
   re-measured at a spot where travelBlocked is false. */
import { boot } from './lib.mjs';
const { page, errs, close } = await boot();

/* (1) + (2) */
const A = await page.evaluate(async () => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const out = { standOffset: [], fit: [] };
  for (const key of ['bike', 'scooter', 'motorcycle']) {
    /* a PRIVATE prop, parked at its own lean, upright in the world, so
       the offset measured is the prop's own geometry and not a pose */
    let prop = null;
    if (key === 'bike') { const m = await import('/src/character/bike.js'); prop = m.createBike(c); }
    else { const m = await import('/src/character/rides.js'); prop = m.createRide ? m.createRide(c, key) : (key === 'scooter' ? m.createScooter(c) : m.createMotorcycle(c)); }
    if (!prop) { out.standOffset.push({ key, error: 'no factory' }); continue; }
    prop.park(true);
    c.scene.add(prop.group);
    prop.group.position.set(0, 0, 0);
    prop.group.rotation.order = 'YXZ';
    prop.group.rotation.set(0, 0, prop.parkLean);
    prop.group.updateMatrixWorld(true);
    let st = null; prop.group.traverse((o) => { if (o.name === 'kickstand') st = o; });
    let painted = null;
    if (st) { st.updateMatrixWorld(true);
      const p = st.geometry.attributes.position, v = new T.Vector3();
      let lo = Infinity;
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(st.matrixWorld); if (v.y < lo) lo = v.y; }
      painted = lo; }
    let design = null;
    if (prop.standFoot) { const v = new T.Vector3(prop.standFoot.x, prop.standFoot.y, prop.standFoot.z).applyMatrix4(prop.group.matrixWorld); design = v.y; }
    out.standOffset.push({ key, leanDeg: +(prop.parkLean * 180 / Math.PI).toFixed(2),
      paintedY: painted == null ? null : +painted.toFixed(5),
      designY: design == null ? null : +design.toFixed(5),
      paintedBelowDesignMM: (painted != null && design != null) ? +((design - painted) * 1000).toFixed(1) : null,
      standVisibleParked: st ? st.visible : null });
    c.scene.remove(prop.group); prop.dispose();
  }
  const t = W.debug.driveTrace('bike', 5.2, 48);
  out.fit = { fitMaxMM: t.fitMaxMM, fitMinMM: t.fitMinMM, fitDriftMM: t.fitDriftMM,
    meanOffsetMM: t.meanOffsetMM, crankTurnsPerCycle: t.crankTurnsPerCycle,
    crankRadPerCycle: t.crankRadPerCycle, dzNoiseFloorM: t.dzNoiseFloorM,
    dzAtTop: t.dzAtTop, driveDirection: t.driveDirection };
  const s = W.debug.driveTrace('scooter', 7.0, 48);
  out.scooterFit = { fitMaxMM: s.fitMaxMM, fitMinMM: s.fitMinMM, fitDriftMM: s.fitDriftMM, ankleDz: s.dzAtTop.ankle };
  return out;
});
console.log('A ' + JSON.stringify(A, null, 1));

/* (3) find an open spot and re-run the top rungs there */
const B = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  const b = c.world.bounds;
  const cand = [];
  for (let x = b.min.x + 40; x <= b.max.x - 40 && cand.length < 400; x += 37)
    for (let z = b.min.z + 40; z <= b.max.z - 40 && cand.length < 400; z += 41) {
      const h = c.world.heightAt(x, z);
      if (!Number.isFinite(h) || h < c.world.seaLevel + 1) continue;
      let flat = true;
      for (let d = 4; d <= 60; d += 8) { const hh = c.world.heightAt(x, z + d); if (!Number.isFinite(hh) || Math.abs(hh - h) > 4) { flat = false; break; } }
      if (flat) cand.push({ x, z, y: h });
    }
  const rows = [];
  const jobs = [['bike', 8.8], ['scooter', 13.2], ['motorcycle', 15.3], ['motorcycle', 26.4]];
  for (const [ride, rung] of jobs) {
    let best = null;
    for (const s of cand.slice(0, 24)) {
      c.wally.setPosition(s.x, s.y, s.z); c.wally.setYaw(0);
      const t = W.debug.driveTrace(ride, rung, 48);
      const row = { ride, rung, at: [+s.x.toFixed(0), +s.z.toFixed(0)], blocked: t.travelBlocked,
        cruise: t.sampledAtCruise, measured: t.rungMeasured, target: t.rungTarget,
        demand: t.revPerMetreDemanded, deliver: t.revPerMetreDelivered, errPct: t.wheelRateErrPct,
        dirs: [t.driveDirection.ankle, t.driveDirection.pedal, t.driveDirection.wheelMark],
        cross: t.wheelRollVsTravel, back: t.maxBackwardStepRad };
      if (!t.travelBlocked && t.sampledAtCruise) { best = row; break; }
      if (!best) best = row;
    }
    rows.push(best);
  }
  return rows;
});
console.log('B ' + JSON.stringify(B, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 5));
await close();
