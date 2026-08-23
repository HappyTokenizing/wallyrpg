/* _jj/clamp.mjs — THE PITCH CLAMP, either side of it.
   Finds real ground at a ladder of gradients (the chord over one
   wheelbase, which is what parkProp() actually samples), parks a
   bicycle there through the real path, and reports both wheel
   clearances. Cross-checks WALLY.debug.parkProbe against my own
   transform of the same two contacts. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();

/* 1. WHERE THE GRADIENTS ARE. Census on a 3 m grid, worst chord at
      each sample, keeping the best site for each degree bucket. */
const sites = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  const B = 0.47;                       // half a wheelbase
  const best = {};
  let n = 0;
  for (let x = -700; x <= 700; x += 6) {
    for (let z = -700; z <= 700; z += 6) {
      const h0 = H(x, z); if (h0 == null) continue;
      n++;
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI;
        const fx = Math.sin(a), fz = Math.cos(a);
        const hf = H(x + fx * B, z + fz * B), hr = H(x - fx * B, z - fz * B);
        if (hf == null || hr == null) continue;
        const deg = Math.abs(Math.atan2(hf - hr, 2 * B) * 180 / Math.PI);
        const b = Math.round(deg);
        if (!best[b]) best[b] = { x, z, yaw: +a.toFixed(3), deg: +deg.toFixed(2) };
      }
    }
  }
  return { samples: n, buckets: best };
});
P('census-samples', sites.samples);
const want = [5, 10, 20, 30, 37, 44, 47, 49, 52, 58, 65, 72];
const chosen = want.map((d) => sites.buckets[d]).filter(Boolean);
P('sites', chosen);

for (const s of chosen) {
  const r = await page.evaluate((q) => {
    const c = window.WALLY.ctx, T = window.WALLY.THREE;
    const out = window.WALLY.debug.parkProbe(q.x, q.z, q.yaw, 'bike');
    /* MY OWN MEASUREMENT of the same two contacts, taken again from
       the live scene after the probe has run — same definition (the
       point at prop-local (x, 0, contactZ), transformed), computed
       here rather than inside the tool being judged. */
    return out;
  }, s);
  P('probe', r);
}

/* 2. AN INDEPENDENT PARK, not through parkProbe: put him there, mount,
      dismount for real, and measure the wheels off the live scene. */
P('== live dismount at a steep site ==', null);
for (const s of [chosen.find((q) => q.deg > 30 && q.deg < 45), chosen.find((q) => q.deg > 50)]) {
  if (!s) continue;
  const r = await page.evaluate(async (q) => {
    const c = window.WALLY.ctx, T = window.WALLY.THREE;
    const H = (x, z) => { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; };
    c.game.actions.grantRide('bike');
    c.wally.setPosition(q.x, H(q.x, q.z), q.z);
    c.wally.setYaw(q.yaw);
    c.game.actions.equipRide('bike');
    await new Promise((r2) => setTimeout(r2, 1600));
    c.game.actions.equipRide(null);
    await new Promise((r2) => setTimeout(r2, 1800));
    const p = c.wally.rideProps.bike; p.group.updateMatrixWorld(true);
    const rows = p.wheels.map((w, i) => {
      let z = 0, x = 0;
      for (let nn = w; nn && nn !== p.group; nn = nn.parent) { z += nn.position.z; x += nn.position.x; }
      const v = new T.Vector3(x, 0, z).applyMatrix4(p.group.matrixWorld);
      const h = H(v.x, v.z);
      return { wheel: i, axleR: +w.position.y.toFixed(3), errMM: h == null ? null : +((v.y - h) * 1000).toFixed(1) };
    });
    return { at: [q.x, q.z], askedDeg: q.deg, parked: c.wally.bikeState.parked,
      pitchDeg: +(p.group.rotation.x * 180 / Math.PI).toFixed(2), wheels: rows };
  }, s);
  P('live', r);
}
P('ERRS', errs.slice(0, 5));
await close();
