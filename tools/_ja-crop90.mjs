#!/usr/bin/env node
/* _ja-crop90.mjs — JUDGE RIG. One pinned 90 m frame, the on/off pair
   taken 400 ms apart with NO re-pin between them so the two exposures
   are the same view, plus the screen coordinates of the people the
   instanced band is drawing, so the crop is aimed instead of guessed. */
import { boot } from './_perf-lib.mjs';
import { mkdir } from 'node:fs/promises';
const ALT = Number(process.argv[2] || 90);
const logs = [];
const { page, close } = await boot({ w: 1600, h: 900, qs: '?skipIntro', logs });
await mkdir('shots/judge3', { recursive: true });
await page.waitForTimeout(4500);
await page.evaluate(() => WALLY.debug.arrive('markethall'));
await page.evaluate(() => { const t = WALLY.ctx.game.time; const w = 13 - (t.hour ?? 12); if (w > 0) t.advance(Math.round(w * 60), 0); });
const HOME = await page.evaluate(() => {
  const c = WALLY.ctx, p = c.wally.position; let sx = 0, sz = 0, w = 0, n = 0;
  for (const h of c.npc.humans) { if (h.asleep) continue;
    const d = Math.hypot(h.root.position.x - p.x, h.root.position.z - p.z);
    if (d > 400 || d < 25) continue; const k = 1 / d;
    sx += h.root.position.x * k; sz += h.root.position.z * k; w += k; n++; }
  const yaw = n ? Math.atan2(sx / w - p.x, sz / w - p.z) : 0; c.wally.setYaw(yaw);
  return { x: p.x, z: p.z }; });
await page.waitForTimeout(2500);
await page.evaluate(() => WALLY.ctx.game.actions.grantRide('balloon'));
await page.waitForTimeout(2500);
let AIMYAW = null;
const hold = async (a) => {
  AIMYAW = await page.evaluate(([a, hx, hz, pre]) => {
    const c = WALLY.ctx;
    WALLY.debug.balloon({ at: [hx, c.world.heightAt(hx, hz) + a + 6, hz] });
    if (pre !== null) { c.wally.setYaw(pre); WALLY.debug.balloon({ alt: a }); return pre; }
    let best = 0, bestN = -1; const near = Math.max(60, a * 2.2), far = Math.max(240, a * 5);
    const gy = c.world.heightAt(hx, hz);
    for (let d = 0; d < 72; d++) { const yaw = d * 5 * Math.PI / 180, fx = Math.sin(yaw), fz = Math.cos(yaw);
      let blocked = false;
      for (let s = 12; s <= 40; s += 14) if (c.world.heightAt(hx - fx * s, hz - fz * s) > gy + a * 0.55) { blocked = true; break; }
      if (blocked) continue; let n = 0;
      for (const h of c.npc.humans) { if (h.asleep) continue;
        const dx = h.root.position.x - hx, dz = h.root.position.z - hz, r = Math.hypot(dx, dz);
        if (r < near || r > far) continue; if ((dx * fx + dz * fz) / r < 0.927) continue; n++; }
      if (n > bestN) { bestN = n; best = yaw; } }
    c.wally.setYaw(best); WALLY.debug.balloon({ alt: a }); return best;
  }, [a, HOME.x, HOME.z, AIMYAW]);
  await page.waitForTimeout(500);
  await page.evaluate((a) => WALLY.debug.balloon({ alt: a }), a);
  await page.waitForTimeout(1100);
};
await hold(ALT); await page.waitForTimeout(3000); await hold(ALT); await page.waitForTimeout(3500); await hold(ALT);
await page.waitForTimeout(1200);
const where = await page.evaluate(() => {
  const c = WALLY.ctx, cam = c.camera; cam.updateMatrixWorld();
  const V = new WALLY.THREE.Vector3(); const out = [];
  for (const h of c.npc.humans) {
    if (h.asleep || !h.airOn) continue;
    V.set(h.root.position.x, h.root.position.y + h.height * 0.5, h.root.position.z).project(cam);
    if (Math.abs(V.x) > 1 || Math.abs(V.y) > 1 || V.z < -1 || V.z > 1) continue;
    const F = new WALLY.THREE.Vector3(h.root.position.x, h.root.position.y, h.root.position.z).project(cam);
    out.push({ x: ((V.x * 0.5 + 0.5) * 1600) | 0, y: ((-V.y * 0.5 + 0.5) * 900) | 0,
      py: ((-F.y * 0.5 + 0.5) * 900) | 0,
      d: +h.dist.toFixed(0), look: +(h.lookW ?? 0).toFixed(2),
      shirt: [Math.round(h.pal.shirt.r * 255), Math.round(h.pal.shirt.g * 255), Math.round(h.pal.shirt.b * 255)],
      skin: [Math.round(h.pal.skin.r * 255), Math.round(h.pal.skin.g * 255), Math.round(h.pal.skin.b * 255)] });
  }
  out.sort((a, b) => a.d - b.d);
  return { n: out.length, s: out, sky: WALLY.debug.skyCrowd() };
});
await page.screenshot({ path: `shots/judge3/pin-${ALT}-on.png`, timeout: 30000 });
await page.evaluate(() => WALLY.debug.skyCrowd('off'));
await page.waitForTimeout(400);
await page.screenshot({ path: `shots/judge3/pin-${ALT}-off.png`, timeout: 30000 });
await page.evaluate(() => WALLY.debug.skyCrowd('on'));
console.log(JSON.stringify(where));
await close();
