#!/usr/bin/env node
/* _ja-look.mjs — JUDGE RIG. Look AT a named point from a low balloon,
   for the question "does the island read as walked-in off the road".
   node tools/_ja-look.mjs x z alt name */
import { boot } from './_perf-lib.mjs';
import { mkdir } from 'node:fs/promises';
const [TX, TZ, ALT, NAME] = [Number(process.argv[2]), Number(process.argv[3]),
  Number(process.argv[4] || 45), process.argv[5] || 'look'];
const logs = [];
const { page, close } = await boot({ w: 1600, h: 900, qs: '?skipIntro', logs });
await mkdir('shots/judge3', { recursive: true });
await page.waitForTimeout(4500);
await page.evaluate(() => WALLY.debug.arrive('waterfront'));
await page.evaluate(() => { const t = WALLY.ctx.game.time; const w = 13 - (t.hour ?? 12); if (w > 0) t.advance(Math.round(w * 60), 0); });
await page.waitForTimeout(2500);
await page.evaluate(() => WALLY.ctx.game.actions.grantRide('balloon'));
await page.waitForTimeout(2500);
/* stand OFF the subject and look back at it, so the subject is in the
   middle of the frame and not under the basket where the boom's 16-30
   degrees of down-pitch cannot see it */
const D = Math.max(60, ALT * 2.4);
const pin = async () => {
  await page.evaluate(([tx, tz, a, d]) => {
    const c = WALLY.ctx;
    /* pick the standoff bearing whose backstop is not a hill */
    let bx = tx + d, bz = tz, best = -1e9;
    for (let k = 0; k < 36; k++) {
      const yaw = k * 10 * Math.PI / 180;
      const x = tx - Math.sin(yaw) * d, z = tz - Math.cos(yaw) * d;
      const gy = c.world.heightAt(x, z);
      let ok = true;
      for (let s = 12; s <= 40; s += 14)
        if (c.world.heightAt(x + Math.sin(yaw) * -s, z + Math.cos(yaw) * -s) > gy + a * 0.55) ok = false;
      if (!ok) continue;
      /* ON LAND. The first run of this rig scored the standoff by
         LOWEST ground and stood the machine over the sea — the exact
         trap the last judge flagged. Land, above the tideline, and the
         flatter the better. */
      if (gy < 2.5) continue;
      const sc = -Math.abs(gy - c.world.heightAt(tx, tz));
      if (sc > best) { best = sc; bx = x; bz = z; }
    }
    WALLY.debug.balloon({ at: [bx, c.world.heightAt(bx, bz) + a + 6, bz] });
    c.wally.setYaw(Math.atan2(tx - bx, tz - bz));
    WALLY.debug.balloon({ alt: a });
  }, [TX, TZ, ALT, D]);
  await page.waitForTimeout(600);
  await page.evaluate((a) => WALLY.debug.balloon({ alt: a }), ALT);
  await page.waitForTimeout(1200);
};
await pin(); await page.waitForTimeout(3000); await pin(); await page.waitForTimeout(3000); await pin();
await page.waitForTimeout(1500);
console.log(JSON.stringify(await page.evaluate(([tx, tz]) => {
  const c = WALLY.ctx, cam = c.camera; cam.updateMatrixWorld();
  const dir = new WALLY.THREE.Vector3(); cam.getWorldDirection(dir);
  return { camY: +cam.position.y.toFixed(1), pitch: +(Math.asin(-dir.y) * 180 / Math.PI).toFixed(1),
    toSubject: +Math.hypot(cam.position.x - tx, cam.position.z - tz).toFixed(1),
    agl: +(c.wally.position.y - c.world.heightAt(c.wally.position.x, c.wally.position.z)).toFixed(1) };
}, [TX, TZ])));
await page.screenshot({ path: `shots/judge3/${NAME}.png`, timeout: 30000 });
await close();
