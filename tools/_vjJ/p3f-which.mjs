/* p3f — there is a green bicycle in BOTH screenshots even though the
   probe says wally.bike is hidden in one of them, so: which bicycle is
   the eye looking at? Project wally.bike to screen, and difference the
   frame with it forcibly detached. Pixels, not flags. */
import { boot } from './lib.mjs';
import { writeFile } from 'node:fs/promises';
const BOTH = process.argv[2] === 'both';
const { page, browser, server } = await boot({ w: 1100, h: 660 });
const door = await page.evaluate((both) => {
  const c = window.WALLY.ctx;
  const v = (c.world.city || c.city).doorPosition('apartment');
  c.game.actions.grantRide('bike');
  if (both) c.game.actions.grantRide('scooter');
  c.game.actions.equipRide('bike');
  c.wally.setPosition(v.x + 2, c.world.heightAt(v.x + 2, v.z + 2), v.z + 2);
  return [v.x, v.y, v.z];
}, BOTH);
await page.waitForTimeout(2600);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(2400);
if (!BOTH) { await page.evaluate(() => window.WALLY.ctx.game.actions.grantRide('scooter')); await page.waitForTimeout(1000); }
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide('scooter'));
await page.waitForTimeout(2400);
await page.mouse.move(550, 380);
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(60); }
await page.keyboard.down('KeyS'); await page.waitForTimeout(800); await page.keyboard.up('KeyS');
await page.waitForTimeout(1500);

const info = await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const g = c.scene.getObjectByName('wally.bike');
  const p = new T.Vector3(); g.getWorldPosition(p); p.y += 0.4; p.project(c.camera);
  /* is any OTHER bicycle-like prop near the door? one named, or one whose
     geometry signature matches the bike (5 capsule spokes per wheel) */
  const others = [];
  c.scene.traverse((o) => {
    if (o === g || !o.isGroup || !o.name) return;
    if (/bike|bicycle|cycle/i.test(o.name)) { const q = new T.Vector3(); o.getWorldPosition(q); others.push({ name: o.name, at: [+q.x.toFixed(1), +q.y.toFixed(1), +q.z.toFixed(1)], visible: o.visible }); }
  });
  return { visible: g.visible, screen: [Math.round((p.x * 0.5 + 0.5) * 1100), Math.round((-p.y * 0.5 + 0.5) * 660)], inFront: p.z < 1, others: others.slice(0, 20) };
});
await page.screenshot({ path: `/tmp/vjJ-f-${BOTH ? 'both' : 'first'}-A.png` });
await page.evaluate(() => { const c = window.WALLY.ctx; const g = c.scene.getObjectByName('wally.bike'); window.__g = g; c.scene.remove(g); });
await page.waitForTimeout(500);
await page.screenshot({ path: `/tmp/vjJ-f-${BOTH ? 'both' : 'first'}-B.png` });
await page.evaluate(() => { window.WALLY.ctx.scene.add(window.__g); });
console.log(JSON.stringify(info));
await browser.close(); server.close();
