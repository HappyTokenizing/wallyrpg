/* _mm/skip.mjs — VERIFY #2. Space pressed mid-ride at several points in
   the opener. What is left standing, and is it on its stand?
   One boot per t, because a skip is terminal. */
import { boot, P } from './lib.mjs';
const TS = (process.argv[2] || '6,12,18,24,30').split(',').map(Number);
for (const AT of TS) {
  const { page, errs, close } = await boot({ query: '', wait: 2500 });
  await page.evaluate(() => {
    const c = window.WALLY.ctx;
    window.__O = { ev: [] };
    c.bus.on('intro:bikeCollected', () => window.__O.ev.push(+c.elapsed.toFixed(2)));
    window.__O.find = () => {
      let g = null; c.scene.traverse((o) => { if (o.name === 'intro.bicycle') g = o; });
      if (!g) return null;
      const T = window.WALLY.THREE; g.updateMatrixWorld(true);
      const ctr = new T.Box3().setFromObject(g, true).getCenter(new T.Vector3());
      let drawn = true; for (let p = g; p; p = p.parent) if (!p.visible) drawn = false;
      let stand = null; g.traverse((o) => { if (o.name === 'kickstand') stand = o.visible; });
      /* HOVER: the lowest point of the drawn machine against the terrain
         under it. A bicycle standing in mid-air reads here and nowhere
         else. */
      const b = new T.Box3().setFromObject(g, true);
      let h = null; try { h = c.world.heightAt(ctr.x, ctr.z); } catch (e) {}
      return { at: g.position.toArray().map((v) => +v.toFixed(2)), drawn, standOut: stand,
        pitchDeg: +(g.rotation.x * 180 / Math.PI).toFixed(1),
        leanDeg: +(g.rotation.z * 180 / Math.PI).toFixed(1), order: g.rotation.order,
        lowestAboveGroundMM: Number.isFinite(h) ? +((b.min.y - h) * 1000).toFixed(0) : null,
        distFromWally: +ctr.distanceTo(c.wally.root.position).toFixed(2) };
    };
  });
  await page.evaluate(() => window.WALLY.debug.begin());
  await page.waitForTimeout(AT * 1000);
  const before = await page.evaluate(() => ({ t: +window.WALLY.ctx.intro.state().t.toFixed(1), seq: window.WALLY.ctx.intro.state().seq, bicycle: window.__O.find() }));
  await page.keyboard.press('Space');
  await page.waitForTimeout(2600);
  const after = await page.evaluate(() => ({ bicycle: window.__O.find(), ev: window.__O.ev }));
  P('t=' + AT, { seq: before.seq, beforeShown: before.bicycle ? before.bicycle.drawn : null,
    after: after.bicycle, collected: after.ev, errs: errs.slice(0, 2) });
  await close();
}
