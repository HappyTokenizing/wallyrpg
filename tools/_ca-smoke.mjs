/* _ca-smoke.mjs — after the rename: boot clean, switch both ways,
   and exercise plant()/clear() with crowns live (clear() is the one
   caller of dropColliders and it now has two ids to let go of). */
import { boot } from './_ca-lib.mjs';
const { page, errs, close } = await boot({ settle: 4500 });
const r = await page.evaluate(() => {
  const t = WALLY.ctx.foliage.trees, phys = WALLY.ctx.phys, w = WALLY.ctx.wally;
  const p = w.root.position;
  const a = { crowns: t.crownCount, bodies: phys.stats.bodies };
  t.setCanopies(true);
  const b = { crowns: t.crownCount, bodies: phys.stats.bodies };
  const planted = t.plant('broadleaf', p.x + 14, p.z + 14);
  const c = { planted, crowns: t.crownCount, bodies: phys.stats.bodies };
  const cleared = t.clear(p.x + 14, p.z + 14, 3);
  const d = { cleared, crowns: t.crownCount, bodies: phys.stats.bodies };
  t.setCanopies(false);
  const e = { crowns: t.crownCount, bodies: phys.stats.bodies };
  return { a, b, c, d, e };
});
console.log(JSON.stringify(r, null, 0));
console.log('ERRORS', errs.length ? errs.slice(0, 6) : 'none');
await close();
