/* P0b — find a door that really opens, so the CONTROL case is honest. */
import { boot, instrument, arm, stop, padGeom, hand, reporter, verbList } from './lib.mjs';
const R = reporter();
const B = await boot();
const { page, cdp } = B;
await instrument(page);
const H = hand(cdp, page);

const list = await page.evaluate(() => {
  const g = WALLY.ctx.game;
  g.state.time = 12 * 60; g.state.money = 5000; g.state.energy = 100;
  return g.data.locations.slice(0, 12).map((l) => ({ id: l.id, n: l.n, open: g.isOpen(l.id), hrs: l.hours }));
});
console.log('locations at 12:00:', JSON.stringify(list, null, 0));

for (const l of list.filter(x => x.open).slice(0, 4)) {
  const info = await page.evaluate((lid) => {
    const g = WALLY.ctx.game;
    const loc = g.data.locationById[lid];
    WALLY.ctx.ui.closeAll();
    const fx = Math.sin(loc.yaw), fz = Math.cos(loc.yaw);
    const out = loc.size.d * 0.5 + 1.6;
    WALLY.ctx.wally.warpTo(loc.world.x + fx * out, WALLY.ctx.wally.position.y + 0.4, loc.world.z + fz * out, {});
    return { id: lid };
  }, l.id);
  await page.waitForTimeout(1600);
  const g = await padGeom(page);
  await arm(page);
  await H.tap(g.act.cx, g.act.cy, 250);
  await H.wait(900);
  const r = await stop(page);
  console.log(`${l.id.padEnd(12)} near=${g.near} actOn=${JSON.stringify(g.act && g.act.hit)}  verbs=${verbList(r)}  panels ${JSON.stringify(r.panels0)}->${JSON.stringify(r.panels)}`);
  if (r.panels.length) {
    R.ok(true, `P0b CONTROL door works at ${l.id}`, `panels ${JSON.stringify(r.panels)}`);
    await page.evaluate(() => WALLY.ctx.ui.closeAll());
    await page.waitForTimeout(400);
    break;
  }
  await page.evaluate(() => WALLY.ctx.ui.closeAll());
  await page.waitForTimeout(300);
}
console.log(`\n${R.fails} failure(s). errs ${B.errs.length}`, B.errs.slice(0, 4).join(' | '));
await B.close();
