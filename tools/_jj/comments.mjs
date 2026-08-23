/* _jj/comments.mjs — the numbers the corrected comments publish,
   measured against the code they sit on. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();

await page.evaluate(() => { const a = window.WALLY.ctx.game.actions; for (const r of ['bike', 'scooter', 'motorcycle']) a.grantRide(r); });

/* build all three props */
for (const r of ['bike', 'scooter', 'motorcycle']) {
  await page.evaluate((x) => window.WALLY.ctx.game.actions.equipRide(x), r);
  await page.waitForTimeout(1200);
}
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(1500);

P('prop-census', await page.evaluate(() => {
  const c = window.WALLY.ctx, out = {};
  for (const k in c.wally.rideProps) {
    const p = c.wally.rideProps[k];
    let meshes = 0, hulls = 0, tris = 0, hullTris = 0, culled = 0;
    const mats = new Set(), geos = new Set();
    p.group.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      if (o.frustumCulled) culled++;
      const g = o.geometry;
      const n = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      const hull = !!o.userData.isOutlineHull || /outline/i.test(o.name);
      if (hull) { hulls++; hullTris += n; } else { tris += n; }
      geos.add(g.uuid);
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m && mats.add(m.uuid));
    });
    out[k] = { meshes, hulls, bodyMeshes: meshes - hulls, bodyTris: tris, hullTris, totalTris: tris + hullTris,
      materials: mats.size, geometries: geos.size, frustumCulledMeshes: culled,
      wheelRadii: p.wheels.map((w) => +w.position.y.toFixed(3)),
      hasStand: !!p.stand, standVisible: p.stand ? p.stand.visible : null,
      parkLean: p.parkLean != null ? +p.parkLean.toFixed(3) : null,
      hasRoll: typeof p.roll === 'function', hasUpdate: typeof p.update === 'function',
      hasSetCrankPhase: typeof p.setCrankPhase === 'function' };
  }
  return out;
}));

/* the stand's foot, and whether it reaches the ground under the lean */
P('stand-geometry', await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE, out = {};
  for (const k of ['scooter', 'motorcycle']) {
    const p = c.wally.rideProps[k]; if (!p || !p.stand) continue;
    p.group.rotation.set(0, 0, 0); p.group.updateMatrixWorld(true);
    const b = new T.Box3().setFromObject(p.stand, true);
    const foot = new T.Vector3(b.max.x, b.min.y, (b.min.z + b.max.z) / 2);
    /* rolled by parkLean about z, what height does the foot reach? */
    const a = p.parkLean;
    const y = foot.y * Math.cos(a) - foot.x * Math.sin(a);
    out[k] = { footLocal: [+foot.x.toFixed(3), +foot.y.toFixed(3)], leanRad: +a.toFixed(3),
      footYAfterLean: +y.toFixed(4), predictedByComment: +(-foot.x * Math.tan(a)).toFixed(4) };
  }
  return out;
}));

/* the ISLAND CENSUS the clamp note cites: 66 058 samples on a 3 m
   grid, median 9 degrees, 8.8% over 30 */
P('census', await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  const B = 0.47, degs = [];
  for (let x = -600; x <= 600; x += 3) {
    for (let z = -600; z <= 600; z += 3) {
      const h0 = H(x, z);
      if (h0 == null || h0 <= 0.05) continue;      // land only
      let worst = 0;
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI;
        const hf = H(x + Math.sin(a) * B, z + Math.cos(a) * B), hr = H(x - Math.sin(a) * B, z - Math.cos(a) * B);
        if (hf == null || hr == null) continue;
        const d = Math.abs(Math.atan2(hf - hr, 2 * B) * 180 / Math.PI);
        if (d > worst) worst = d;
      }
      degs.push(worst);
    }
  }
  degs.sort((a, b) => a - b);
  const q = (p) => +degs[Math.floor(degs.length * p)].toFixed(1);
  return { samples: degs.length, median: q(0.5), p90: q(0.9), p99: q(0.99),
    pctOver30: +(100 * degs.filter((d) => d > 30).length / degs.length).toFixed(1),
    pctOver48: +(100 * degs.filter((d) => d > 48).length / degs.length).toFixed(2) };
}));

/* bike.js's own fit numbers, which a downstream note quotes */
P('fit', await page.evaluate(() => {
  const t = window.WALLY.debug.driveTrace('bike', 5.1, 48);
  return { fitMaxMM: t.fitMaxMM ?? t.fitMax, fitDriftMM: t.fitDriftMM ?? t.fitDrift, keys: Object.keys(t).filter((k) => /fit/i.test(k)) };
}));
P('rideInfo.cost', await page.evaluate(() => {
  const i = window.WALLY.debug.rideInfo ? window.WALLY.debug.rideInfo() : null;
  return i && (i.cost || i);
}));
P('ERRS', errs.slice(0, 5));
await close();
