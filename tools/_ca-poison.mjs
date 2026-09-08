/* _ca-poison.mjs — BEFORE WRITING A LINE OF trees.js.

   collision.js groundAt() casts DOWN FROM THE TOP OF THE WORLD BOUNDS
   and answers the FIRST solid it meets. Three consumers call it with
   no fromY:
     src/character/secondary.js:1029/1039  foot IK  (gRef and per-foot)
     src/core/camera.js:973                lensFloor
     src/core/camera.js:1170               skyline
   A canopy is the first solid over walkable ground this island would
   ever have. So: hang ONE canopy-shaped OBB over Wally's head through
   phys's own public API and see what those three do. No src edits.
*/
import { boot } from './_ca-lib.mjs';

const { page, errs, close } = await boot({ settle: 5000 });

const read = () => page.evaluate(() => {
  const T3 = WALLY.THREA || WALLY.THREE;
  const w = WALLY.ctx.wally, phys = WALLY.ctx.phys, cam = WALLY.ctx.camera;
  const r = w.root;
  const p = r.position;
  const bb = new T3.Box3().setFromObject(r);
  return {
    wally: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
    bbMinY: +bb.min.y.toFixed(3), bbMaxY: +bb.max.y.toFixed(3),
    groundAt: +phys.groundAt(p.x, p.z).y.toFixed(3),
    terrain: +WALLY.ctx.world.heightAt(p.x, p.z).toFixed(3),
    camY: +cam.position.y.toFixed(3),
    camPos: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
  };
});

const A = await read();
console.log('A  no canopy        ', JSON.stringify(A));

/* A broadleaf-sized crown, 2.90 -> 7.20 m over the terrain, centred on
   his own axis: exactly what trees.js would register. */
const built = await page.evaluate(() => {
  const T3 = WALLY.THREE, phys = WALLY.ctx.phys, w = WALLY.ctx.wally;
  const p = w.root.position, gy = WALLY.ctx.world.heightAt(p.x, p.z);
  const CB = 2.90, CT = 7.20, CR = 2.10;
  const m = new T3.Matrix4().makeTranslation(p.x, gy + (CB + CT) * 0.5, p.z);
  window.__CANOPY = phys.addOBB(CR * 2, CT - CB, CR * 2, m, { name: 'test.canopy', prop: true });
  return { id: window.__CANOPY, CB, CT, CR, gy: +gy.toFixed(2) };
});
console.log('   registered        ', JSON.stringify(built));
await page.waitForTimeout(1200);
const B = await read();
console.log('B  canopy overhead  ', JSON.stringify(B));

/* and walk him a few metres under it, which is what a player does */
await page.keyboard.down('KeyW');
await page.waitForTimeout(1500);
await page.keyboard.up('KeyW');
await page.waitForTimeout(600);
const C = await read();
console.log('C  after walking    ', JSON.stringify(C));

await page.evaluate(() => WALLY.ctx.phys.remove(window.__CANOPY));
await page.waitForTimeout(1200);
const D = await read();
console.log('D  canopy removed   ', JSON.stringify(D));

console.log('\nfoot IK:  bbMinY over terrain  A ' + (A.bbMinY - A.terrain).toFixed(3) +
  '  B ' + (B.bbMinY - B.terrain).toFixed(3) + '  C ' + (C.bbMinY - C.terrain).toFixed(3) +
  '  D ' + (D.bbMinY - D.terrain).toFixed(3));
console.log('camera:   camY  A ' + A.camY + '  B ' + B.camY + '  C ' + C.camY + '  D ' + D.camY);
console.log('groundAt: A ' + A.groundAt + '  B ' + B.groundAt + '  C ' + C.groundAt + '  D ' + D.groundAt);
if (errs.length) console.log('ERRORS', errs.slice(0, 6));
await close();
