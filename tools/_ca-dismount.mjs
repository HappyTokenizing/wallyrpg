/* _ca-dismount.mjs — THE NEW STATE THIS PASS CREATES.

   Before canopies, a balloon could not come to rest six metres up in a
   tree. Now it can, and getting off it there is a situation nobody has
   ever been in. The gate drops every crown on 'wally:fly' {flying:
   false}, so the question is what the character does in the frame
   after the thing he is standing on stops existing. */
import { boot } from './_ca-lib.mjs';

const { page, errs, close } = await boot({ settle: 5000 });
const J = (o) => JSON.stringify(o);

const out = await page.evaluate(async () => {
  const T3 = WALLY.THREE, t = WALLY.ctx.foliage.trees, W = WALLY.ctx.world, w = WALLY.ctx.wally;
  const v = t.bestView(50, 26);
  const rows = t.crownBoxes();
  let best = null;
  for (const r of rows) {
    const d = Math.hypot(r.x - v.tx, r.z - v.tz);
    let n = 0;
    for (const o of rows) if (Math.hypot(o.x - r.x, o.z - r.z) < 12) n++;
    const sc = n - d * 0.35;
    if (!best || sc > best.sc) best = { sc, r };
  }
  const site = best.r;
  const gy = W.heightAt(site.x, site.z);
  w.controller.teleport(new T3.Vector3(site.x + 9, W.heightAt(site.x + 9, site.z) + 1, site.z));
  await new Promise((k) => setTimeout(k, 2600));
  WALLY.ctx.wind.setStrength(0);
  WALLY.debug.balloon();
  await new Promise((k) => setTimeout(k, 600));
  WALLY.debug.balloon({ alt: 1, at: [site.x, gy + 0.3, site.z] });
  WALLY.debug.balloon({ alt: 7 });
  let still = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 45000) {
    await new Promise((r) => requestAnimationFrame(r));
    const p = w.position;
    WALLY.debug.balloonStick(
      Math.max(-1, Math.min(1, (site.x - p.x) * 0.35)),
      Math.max(-1, Math.min(1, (site.z - p.z) * 0.35)));
    still = Math.abs(w.flightState.vy) < 0.02 ? still + 1 : 0;
    if (still > 45) break;
  }
  WALLY.debug.balloonStick(null, null);
  const rest = { over: +(w.position.y - gy).toFixed(2), crowns: t.crownCount, crownTop: +site.highOverBase.toFixed(2) };

  /* off she gets, in a tree */
  WALLY.debug.balloon(false);
  const after = [];
  for (let i = 0; i < 5; i++) {
    await new Promise((k) => setTimeout(k, 500));
    after.push({ t: (i + 1) * 0.5, over: +(w.root.position.y - gy).toFixed(2), crowns: t.crownCount, grounded: !!w.controller?.grounded });
  }
  return { site: { x: +site.x.toFixed(1), z: +site.z.toFixed(1), kind: site.kind, gy: +gy.toFixed(2) }, rest, after };
});
console.log('SITE  ' + J(out.site));
console.log('REST  ' + J(out.rest));
console.log('AFTER DISMOUNT (metres over the terrain under the tree)');
for (const a of out.after) console.log('   +' + a.t + ' s  ' + J(a));
if (errs.length) console.log('ERRORS', errs.slice(0, 8));
await close();
