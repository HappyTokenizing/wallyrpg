/* _ca-poison2.mjs — the same experiment, but reading the ANKLES rather
   than a bounding box (the root's box is pinned by the contact shadow,
   which is why run 1 showed no foot movement). Wide crown so he stays
   under it for a whole walk. */
import { boot } from './_ca-lib.mjs';

const { page, errs, close } = await boot({ settle: 5000 });

const read = () => page.evaluate(() => {
  const T3 = WALLY.THREE, w = WALLY.ctx.wally, phys = WALLY.ctx.phys, cam = WALLY.ctx.camera;
  const r = w.root, p = r.position, v = new T3.Vector3();
  const gy = WALLY.ctx.world.heightAt(p.x, p.z);
  const foot = (n) => { const o = r.getObjectByName(n); if (!o) return null; o.getWorldPosition(v); return +(v.y - gy).toFixed(3); };
  return {
    at: [+p.x.toFixed(2), +p.z.toFixed(2)],
    footL: foot('footL'), footR: foot('footR'),
    names: r.getObjectByName('footL') ? null : Array.from(new Set(((arr) => { r.traverse((o) => { if (o.name) arr.push(o.name); }); return arr; })([]))).slice(0, 40),
    groundOverTerrain: +(phys.groundAt(p.x, p.z).y - gy).toFixed(3),
    camOverTerrain: +(cam.position.y - gy).toFixed(3),
  };
});

console.log('A idle, no canopy   ', JSON.stringify(await read()));

const built = await page.evaluate(() => {
  const T3 = WALLY.THREE, phys = WALLY.ctx.phys, w = WALLY.ctx.wally;
  const p = w.root.position, gy = WALLY.ctx.world.heightAt(p.x, p.z);
  const CB = 2.90, CT = 7.20, CR = 9.0;      // wide, so a 12 m walk stays under it
  const m = new T3.Matrix4().makeTranslation(p.x, gy + (CB + CT) * 0.5, p.z);
  window.__CANOPY = phys.addOBB(CR * 2, CT - CB, CR * 2, m, { name: 'test.canopy', prop: true });
  return { CB, CT, CR };
});
console.log('  canopy            ', JSON.stringify(built));
await page.waitForTimeout(1500);
console.log('B idle, under canopy', JSON.stringify(await read()));

await page.keyboard.down('KeyW');
const walking = [];
for (let i = 0; i < 6; i++) { await page.waitForTimeout(350); walking.push(await read()); }
await page.keyboard.up('KeyW');
console.log('C walking under it:');
for (const r of walking) console.log('   ', JSON.stringify({ at: r.at, footL: r.footL, footR: r.footR, cam: r.camOverTerrain }));

await page.evaluate(() => WALLY.ctx.phys.remove(window.__CANOPY));
await page.waitForTimeout(1500);
console.log('D canopy removed    ', JSON.stringify(await read()));
if (errs.length) console.log('ERRORS', errs.slice(0, 6));
await close();
