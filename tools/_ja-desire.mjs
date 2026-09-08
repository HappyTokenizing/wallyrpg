#!/usr/bin/env node
/* _ja-desire.mjs — JUDGE RIG. Walk ONE desire path, on the real keys,
   from the road it leaves to the place it goes, and shoot it from the
   follow lens. physTeleport() is used to place him because writing
   ctx.wally.position directly does not move the controller's sim and
   the first run of this rig walked 300 m in the wrong direction. */
import { boot } from './_perf-lib.mjs';
import { mkdir } from 'node:fs/promises';
const WHICH = process.argv[2] || 'adit';
const logs = [];
const { page, close } = await boot({ w: 1600, h: 900, qs: '?skipIntro', logs });
await mkdir('shots/judge3', { recursive: true });
await page.waitForTimeout(4500);
const g = await page.evaluate(() => {
  const s = WALLY.ctx.city.groundStats;
  return { desirePaths: s.desirePaths, destPaths: s.destPaths, destAt: s.destAt,
    approaches: s.approaches, kerbMetres: s.kerbMetres, destTris: s.destTris, tris: s.tris };
});
console.log('ground ' + JSON.stringify(g));
const target = g.destAt.find((d) => d.startsWith(WHICH)) || g.destAt[0];
const m = /@(-?\d+),(-?\d+)\s+(\d+)m/.exec(target);
const DX = Number(m[1]), DZ = Number(m[2]), LEN = Number(m[3]);
console.log('walking ' + target);
/* THE ROAD END. ground.js laid the track from a road; pavedAt() is its
   own record of what it laid, so the start is found by walking OUT
   from the destination along the worn strip until the strip widens
   into something a road-width test passes. */
const start = await page.evaluate(([dx, dz, len]) => {
  const c = WALLY.ctx, P = c.city.pavedAt;
  let best = null;
  for (let a = 0; a < 360; a += 3) {
    const rad = a * Math.PI / 180;
    let run = 0;
    for (let r = 4; r <= len + 40; r += 2) {
      const x = dx + Math.sin(rad) * r, z = dz + Math.cos(rad) * r;
      if (P(x, z) > 0.4) { run++; if (run >= 6 && (!best || r > best.r)) best = { x, z, r, a, run }; }
      else if (run) break;
    }
  }
  return best;
}, [DX, DZ, LEN]);
console.log('road end of the track: ' + JSON.stringify(start));
const S = start || { x: DX + LEN, z: DZ };
await page.evaluate(([x, z, dx, dz]) => {
  const c = WALLY.ctx;
  WALLY.debug.physTeleport(x, c.world.heightAt(x, z) + 0.4, z);
  c.wally.setYaw(Math.atan2(dx - x, dz - z));
}, [S.x, S.z, DX, DZ]);
await page.waitForTimeout(3000);
await page.screenshot({ path: 'shots/judge3/desire-start.png', timeout: 30000 });
const track = [];
for (let i = 0; i < 22; i++) {
  await page.evaluate(([dx, dz]) => {
    const c = WALLY.ctx, p = c.wally.position;
    c.wally.setYaw(Math.atan2(dx - p.x, dz - p.z));
  }, [DX, DZ]);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1100);
  await page.keyboard.up('KeyW');
  const s = await page.evaluate(([dx, dz]) => {
    const c = WALLY.ctx, p = c.wally.position;
    return { x: +p.x.toFixed(1), z: +p.z.toFixed(1),
      paved: +c.city.pavedAt(p.x, p.z).toFixed(2),
      /* AND WHAT IS 6 m TO EITHER SIDE, so "he is on a laid strip" is
         distinguished from "everything here is laid" */
      offL: +c.city.pavedAt(p.x + 6, p.z).toFixed(2),
      offR: +c.city.pavedAt(p.x - 6, p.z).toFixed(2),
      to: +Math.hypot(p.x - dx, p.z - dz).toFixed(1) };
  }, [DX, DZ]);
  track.push(s);
  if (i === 6) await page.screenshot({ path: 'shots/judge3/desire-mid.png', timeout: 30000 });
  if (s.to < 10) break;
}
console.log(' step      x       z   paved  +6m  -6m   m-to-go');
track.forEach((s, i) => console.log('  ' + String(i + 1).padStart(3) + '  ' + String(s.x).padStart(7)
  + ' ' + String(s.z).padStart(7) + '  ' + String(s.paved).padStart(5)
  + ' ' + String(s.offL).padStart(4) + ' ' + String(s.offR).padStart(4) + '  ' + String(s.to).padStart(7)));
const on = track.filter((s) => s.paved > 0.3).length;
const off = track.filter((s) => s.offL > 0.3 || s.offR > 0.3).length;
console.log(`  on the strip ${on}/${track.length}; the ground 6 m aside is laid in ${off}/${track.length}`);
console.log('  he covered ' + (track.length ? (track[0].to - track[track.length - 1].to).toFixed(1) : 0)
  + ' m of the ' + LEN + ' m track');
await page.screenshot({ path: 'shots/judge3/desire-end.png', timeout: 30000 });
const errs = logs.filter((l) => l.startsWith('[PAGEERROR]'));
if (errs.length) console.log('ERRORS: ' + errs.slice(0, 5).join(' | '));
await close();
