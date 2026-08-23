/* _jj/skip.mjs — the opener SKIPPED mid-ride. restoreWorld() sets
   retire in both paths, so a skip taken while he is still pedalling
   leaves the arrival bicycle wherever the ride had got to. */
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
    const n = ctr.clone().project(c.camera);
    let drawn = true; for (let p = g; p; p = p.parent) if (!p.visible) drawn = false;
    return { at: g.position.toArray().map((v) => +v.toFixed(2)), drawn,
      rotXdeg: +(g.rotation.x * 180 / Math.PI).toFixed(1), rotZdeg: +(g.rotation.z * 180 / Math.PI).toFixed(1),
      distFromWally: +ctr.distanceTo(c.wally.root.position).toFixed(2),
      inFrame: n.z < 1 && Math.abs(n.x) < 1 && Math.abs(n.y) < 1 };
  };
});
await page.evaluate(() => window.WALLY.debug.begin());
await page.waitForTimeout(AT * 1000);
P('at-skip-moment', await page.evaluate(() => ({ t: +window.WALLY.ctx.elapsed.toFixed(1), st: window.WALLY.ctx.intro.state(), bicycle: window.__O.find() })));
await page.keyboard.press('Space');
await page.waitForTimeout(3000);
P('after-skip', await page.evaluate(() => ({ t: +window.WALLY.ctx.elapsed.toFixed(1), running: window.WALLY.ctx.intro.state().running, bicycle: window.__O.find(), ev: window.__O.ev })));
await page.screenshot({ path: '/tmp/jj-skip-' + AT + '.png' });
await page.waitForTimeout(4000);
P('after-skip+4s', await page.evaluate(() => ({ bicycle: window.__O.find(), ev: window.__O.ev })));
await page.screenshot({ path: '/tmp/jj-skip-' + AT + 'b.png' });
P('ERRS', errs.slice(0, 5));
await close();
