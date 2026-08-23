/* _kk/opener.mjs — the WATCHED opener, end to end: does the arrival
   bicycle still park at the hero mark, hand over, and get collected? */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ query: '', wait: 2500 });
await page.evaluate(() => {
  const c = window.WALLY.ctx;
  window.__O = { ev: [] };
  c.bus.on('intro:bikeCollected', () => window.__O.ev.push(+c.elapsed.toFixed(2)));
  window.__O.find = () => {
    let g = null; c.scene.traverse((o) => { if (o.name === 'intro.bicycle') g = o; });
    if (!g) return null;
    let stand = null; g.traverse((o) => { if (o.name === 'kickstand') stand = o.visible; });
    let drawn = true; for (let p = g; p; p = p.parent) if (!p.visible) drawn = false;
    return { at: g.position.toArray().map((v) => +v.toFixed(2)), drawn, standOut: stand,
      leanDeg: +(g.rotation.z * 180 / Math.PI).toFixed(1), order: g.rotation.order };
  };
});
await page.evaluate(() => window.WALLY.debug.begin());
await page.waitForTimeout(28500);
P('at-hero', await page.evaluate(() => ({ st: window.WALLY.ctx.intro.state().seq, bicycle: window.__O.find() })));
await page.waitForTimeout(9000);
P('handed-over', await page.evaluate(() => ({ running: window.WALLY.ctx.intro.state().running, bicycle: window.__O.find(), ev: window.__O.ev })));
await page.screenshot({ path: '/tmp/kk-opener.png' });
/* walk away — the camera follows his back, so the bicycle leaves frame */
await page.keyboard.down('KeyW');
await page.waitForTimeout(6000);
await page.keyboard.up('KeyW');
await page.waitForTimeout(1500);
P('after-looking-away', await page.evaluate(() => ({ bicycle: window.__O.find(), ev: window.__O.ev })));
P('ERRS', errs.slice(0, 6));
await close();
