/* p4b — find a runway. The first cut of p4 measured a motorcycle
   "cruising" at 1.3 m/s because the spot I picked outside the apartment
   has a wall 20 m down every heading; driveTrace's own travelBlocked
   never fired because `expected` is derived from the same stalled
   average it is checking. So the runway is chosen by DRIVING it. */
import { boot } from './lib.mjs';
const { page, browser, server } = await boot({ w: 700, h: 460 });
await page.evaluate(() => { const c = window.WALLY.ctx; c.game.actions.grantRide('motorcycle'); c.game.actions.equipRide('motorcycle'); });
await page.waitForTimeout(2600);

const sites = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : NaN; } catch (e) { return NaN; } };
  const out = [];
  for (let i = 0; i < 400; i++) {
    const x = (Math.random() * 2 - 1) * 420, z = (Math.random() * 2 - 1) * 420;
    const h = H(x, z);
    if (!(h > 2)) continue;
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      let ok = true, maxd = 0;
      for (let d = 2; d <= 120; d += 2) {
        const hh = H(x + fx * d, z + fz * d);
        if (!(hh > 1.5) || Math.abs(hh - h) > 6) { ok = false; break; }
        maxd = d;
      }
      if (ok) out.push({ x: +x.toFixed(2), z: +z.toFixed(2), y: +h.toFixed(2), yaw: +yaw.toFixed(3), clear: maxd });
    }
  }
  return out.slice(0, 24);
});

const tried = [];
for (const s of sites.slice(0, 14)) {
  await page.evaluate((q) => { const c = window.WALLY.ctx; c.wally.setPosition(q.x, c.world.heightAt(q.x, q.z), q.z); c.wally.setYaw(q.yaw); }, s);
  await page.waitForTimeout(900);
  await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  const v = await page.evaluate(() => window.WALLY.ctx.wally.controller.planarSpeed);
  await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
  await page.waitForTimeout(600);
  tried.push({ ...s, reached: +v.toFixed(2) });
}
tried.sort((a, b) => b.reached - a.reached);
console.log(JSON.stringify(tried.slice(0, 6), null, 1));
await browser.close(); server.close();
