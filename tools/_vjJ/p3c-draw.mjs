/* p3c — is the left-behind bicycle actually DRAWN, and what does it cost?
   Draw cost is measured as a controlled A/B against the SAME camera and
   the same frame budget: sample renderer.info with the parked prop shown,
   again with it hidden, again shown. The city's own LOD moves with the
   player, so a before/after taken at two different places is not a
   measurement of anything. */
import { boot } from './lib.mjs';
const BOTH = process.argv[2] === 'both';
const { page, browser, server, errs } = await boot({ w: 1100, h: 660 });

await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const r = (c.render && c.render.renderer) || c.renderer;
  window.__C = {
    async cost(n = 60) {
      const calls = [], tris = [];
      await new Promise((res) => { let i = 0; const t = () => { calls.push(r.info.render.calls); tris.push(r.info.render.triangles); if (++i >= n) res(); else requestAnimationFrame(t); }; requestAnimationFrame(t); });
      const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
      return { calls: med(calls), tri: med(tris) };
    },
    bikeGroup() { return c.scene.getObjectByName('wally.bike'); },
  };
});

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

/* the player's own camera: wheel out, then walk a few metres off */
await page.mouse.move(550, 380);
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(60); }
await page.keyboard.down('KeyS'); await page.waitForTimeout(900); await page.keyboard.up('KeyS');
await page.waitForTimeout(1400);
await page.screenshot({ path: `/tmp/vjJ-p3c-${BOTH ? 'both' : 'bikefirst'}.png` });

/* controlled A/B on the parked prop's draw cost */
const shown1 = await page.evaluate(() => window.__C.cost());
const vis = await page.evaluate(() => { const g = window.__C.bikeGroup(); const v = g.visible; g.visible = false; return v; });
await page.waitForTimeout(300);
const hidden = await page.evaluate(() => window.__C.cost());
await page.evaluate((v) => { window.__C.bikeGroup().visible = v; }, vis);
await page.waitForTimeout(300);
const shown2 = await page.evaluate(() => window.__C.cost());

/* ride out past PARK_DRAW_M and back */
await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW');
await page.waitForTimeout(7000);
await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
await page.waitForTimeout(1200);
const far = await page.evaluate((d) => {
  const c = window.WALLY.ctx, g = window.__C.bikeGroup();
  return { dist: +Math.hypot(c.wally.root.position.x - d[0], c.wally.root.position.z - d[2]).toFixed(1),
    camDist: +c.camera.position.distanceTo(g.position).toFixed(1), visible: g.visible, parent: g.parent === c.scene ? 'scene' : 'other' };
}, door);
const farCost = await page.evaluate(() => window.__C.cost());

console.log(JSON.stringify({ ownedScooterFirst: BOTH, bikeVisibleWhenOnScooter: vis,
  cost: { shownA: shown1, hidden, shownB: shown2,
    deltaCalls: shown1.calls - hidden.calls, deltaTri: shown1.tri - hidden.tri },
  far, farCost, errs: errs.slice(0, 5) }, null, 1));
await browser.close(); server.close();
