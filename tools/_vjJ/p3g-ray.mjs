/* p3g — the pixel diff was useless (the crowd, the foliage and the sea
   move between any two frames, so 60% of the image differs whatever I
   do). Raycast instead: fire through the screen point where the green
   bicycle is drawn and name whatever the ray actually hits. */
import { boot } from './lib.mjs';
const BOTH = process.argv[2] === 'both';
const { page, browser, server } = await boot({ w: 1100, h: 660 });
await page.evaluate((both) => {
  const c = window.WALLY.ctx;
  const v = (c.world.city || c.city).doorPosition('apartment');
  c.game.actions.grantRide('bike');
  if (both) c.game.actions.grantRide('scooter');
  c.game.actions.equipRide('bike');
  c.wally.setPosition(v.x + 2, c.world.heightAt(v.x + 2, v.z + 2), v.z + 2);
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
const out = await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const g = c.scene.getObjectByName('wally.bike');
  const p = new T.Vector3(); g.getWorldPosition(p); p.y += 0.35;
  const proj = p.clone().project(c.camera);
  const sx = (proj.x * 0.5 + 0.5) * 1100, sy = (-proj.y * 0.5 + 0.5) * 660;
  const rc = new T.Raycaster();
  const hits = [];
  for (const [dx, dy] of [[0, 0], [-14, 0], [14, 0], [0, -20], [0, 20], [-8, 12]]) {
    rc.setFromCamera(new T.Vector2(((sx + dx) / 1100) * 2 - 1, -(((sy + dy) / 660) * 2 - 1)), c.camera);
    const h = rc.intersectObjects(c.scene.children, true).filter((k) => k.object.visible);
    const top = h[0];
    let chain = '';
    if (top) { let n = top.object; const names = []; while (n) { if (n.name) names.push(n.name); n = n.parent; } chain = names.join('<'); }
    hits.push({ at: [Math.round(sx + dx), Math.round(sy + dy)], hit: top ? (chain || top.object.type) : null, dist: top ? +top.distance.toFixed(2) : null });
  }
  return { bikeVisible: g.visible, bikeScreen: [Math.round(sx), Math.round(sy)], hits };
});
console.log(JSON.stringify(out));
await browser.close(); server.close();
