/* _ll/skipride.mjs — Space pressed MID-RIDE, deterministically.

   Wall-clock waits cannot hit the ride: the director's clock is driven
   by the frame loop, so under a loaded machine 24 seconds of wall time
   lands three seconds of film earlier than it does on an idle one —
   measured, two runs of _kk/skip.mjs four seconds apart both arriving
   at director t = 15.3. Seek to the mark instead, let the ride run for
   a moment, then skip.

   THEN MEASURE THE MACHINE, NOT ITS POSE. Both wheel contacts against
   ctx.world.heightAt at their own world positions, taken as the point
   directly under each axle in the PROP's frame — bike.js puts the
   group origin on the ground under the bottom bracket, so the contacts
   are local (0, 0, +/-wheelbase/2) and the world matrix does the rest.
   Never wheel-local (0, -R, 0): that is a material point on the rim
   and carries the rolling angle with it. */
import { boot, P } from './lib.mjs';
const MARK = +(process.argv[2] ?? 5);
const DWELL = +(process.argv[3] ?? 1400);
const { page, errs, close } = await boot({ query: '', wait: 2500 });

await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  window.__A = { ev: [] };
  c.bus.on('intro:bikeCollected', () => window.__A.ev.push(+c.elapsed.toFixed(2)));
  window.__A.find = () => {
    let g = null; c.scene.traverse((o) => { if (o.name === 'intro.bicycle') g = o; });
    if (!g) return null;
    g.updateMatrixWorld(true);
    let stand = null; g.traverse((o) => { if (o.name === 'kickstand') stand = o.visible; });
    let drawn = true; for (let p = g; p; p = p.parent) if (!p.visible) drawn = false;
    /* wheelbase off the object: the two children furthest apart on z
       whose y sits at a plausible axle height */
    let zf = -1e9, zr = 1e9;
    g.traverse((o) => {
      if (o === g || o.position.y < 0.15 || o.position.y > 0.6) return;
      if (Math.abs(o.position.z) < 0.25) return;
      zf = Math.max(zf, o.position.z); zr = Math.min(zr, o.position.z);
    });
    const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
    const wheels = [zf, zr].map((z) => {
      if (!Number.isFinite(z) || Math.abs(z) > 3) return null;
      const v = new T.Vector3(0, 0, z).applyMatrix4(g.matrixWorld);
      const h = H(v.x, v.z);
      return h == null ? null : +((v.y - h) * 1000).toFixed(1);
    });
    return { at: g.position.toArray().map((v) => +v.toFixed(2)), drawn,
      pitchDeg: +(g.rotation.x * 180 / Math.PI).toFixed(2),
      leanDeg: +(g.rotation.z * 180 / Math.PI).toFixed(1),
      order: g.rotation.order, standOut: stand,
      wheelbase: +(zf - zr).toFixed(3), wheelMM: wheels,
      distFromWally: +g.position.distanceTo(c.wally.root.position).toFixed(2) };
  };
});
await page.evaluate(() => window.WALLY.debug.begin());
await page.waitForTimeout(1200);
const m = await page.evaluate((n) => window.WALLY.debug.introShot(n), MARK);
P('mark', m);
await page.waitForTimeout(DWELL);
P('mid', await page.evaluate(() => ({ seq: window.WALLY.ctx.intro.state().seq, bicycle: window.__A.find() })));
await page.keyboard.press('Space');
await page.waitForTimeout(2600);
P('afterSkip', await page.evaluate(() => ({ running: window.WALLY.ctx.intro.state().running, bicycle: window.__A.find(), ev: window.__A.ev })));
await page.screenshot({ path: '/tmp/ll-skip-mark' + MARK + '.png' });
await page.waitForTimeout(5200);
P('plus5s', await page.evaluate(() => ({ bicycle: window.__A.find(), ev: window.__A.ev })));
P('ERRS', errs.slice(0, 5));
await close();
