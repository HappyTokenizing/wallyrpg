/* _kk/skip.mjs — Space pressed at t seconds. What is left standing?
   node tools/_kk/skip.mjs 24 */
import { boot, P } from './lib.mjs';
const AT = +(process.argv[2] || 24);
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
    /* THE STAND IS THE POINT. A leaning bicycle with the stand hidden
       is the same defect wearing a different pose. */
    let stand = null;
    g.traverse((o) => { if (o.name === 'kickstand') stand = o.visible; });
    return { at: g.position.toArray().map((v) => +v.toFixed(2)), drawn,
      pitchDeg: +(g.rotation.x * 180 / Math.PI).toFixed(1),
      leanDeg: +(g.rotation.z * 180 / Math.PI).toFixed(1),
      order: g.rotation.order, standOut: stand,
      distFromWally: +ctr.distanceTo(c.wally.root.position).toFixed(2) };
  };
});
await page.evaluate(() => window.WALLY.debug.begin());
await page.waitForTimeout(AT * 1000);
P('before', await page.evaluate(() => ({ t: +window.WALLY.ctx.intro.state().t.toFixed(1), seq: window.WALLY.ctx.intro.state().seq, bicycle: window.__O.find() })));
await page.keyboard.press('Space');
await page.waitForTimeout(2600);
P('after', await page.evaluate(() => ({ running: window.WALLY.ctx.intro.state().running, bicycle: window.__O.find(), ev: window.__O.ev })));
await page.screenshot({ path: '/tmp/kk-skip-' + AT + '.png' });
await page.waitForTimeout(5000);
P('after+5s', await page.evaluate(() => ({ bicycle: window.__O.find(), ev: window.__O.ev })));
P('ERRS', errs.slice(0, 5));
await close();
