import { boot } from './lib.mjs';
const { page, errs, close } = await boot();
const o = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  return { debugKeys: Object.keys(W.debug).sort(), cell: c.world.CELL ?? null,
    bounds: { min: [c.world.bounds.min.x, c.world.bounds.min.z], max: [c.world.bounds.max.x, c.world.bounds.max.z] },
    sea: c.world.seaLevel, rides: Object.keys(c.wally.rideProps || {}),
    hasIsRoad: typeof c.world.isRoad, three: W.THREE.REVISION };
});
console.log(JSON.stringify(o, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 6));
await close();
