/* _kk/seek.mjs — the debug seek path: ride mark, then hero mark. The
   machine must end up on its stand at the hero placement. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ query: '', wait: 2500 });
const find = () => page.evaluate(() => {
  const c = window.WALLY.ctx;
  let g = null; c.scene.traverse((o) => { if (o.name === 'intro.bicycle') g = o; });
  if (!g) return null;
  let stand = null; g.traverse((o) => { if (o.name === 'kickstand') stand = o.visible; });
  return { at: g.position.toArray().map((v) => +v.toFixed(2)), standOut: stand, order: g.rotation.order };
});
for (const n of [5, 6, 5, 6, 7]) {
  await page.evaluate((k) => window.WALLY.debug.introShot(k), n);
  await page.waitForTimeout(1400);
  P('mark' + n, await find());
}
P('ERRS', errs.slice(0, 5));
await close();
