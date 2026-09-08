#!/usr/bin/env node
/* _ja-desire2.mjs — JUDGE RIG. Find one destination desire path by
   sampling ground.js's OWN paved map at its own 0.25 m cell (the first
   version of this rig stepped 2 m and found nothing, which is a rig
   failure and not an absent path), draw it, then WALK it with the real
   keys under closed-loop steering — the keys are camera-relative, so a
   heading has to be flown, not set. */
import { boot } from './_perf-lib.mjs';
import { mkdir } from 'node:fs/promises';
const WHICH = process.argv[2] || 'adit';
const logs = [];
const { page, close } = await boot({ w: 1600, h: 900, qs: '?skipIntro', logs });
await mkdir('shots/judge3', { recursive: true });
await page.waitForTimeout(4500);
await page.evaluate(() => { const t = WALLY.ctx.game.time; const w = 13 - (t.hour ?? 12); if (w > 0) t.advance(Math.round(w * 60), 0); });
await page.waitForTimeout(1500);
const g = await page.evaluate(() => { const s = WALLY.ctx.city.groundStats;
  return { desirePaths: s.desirePaths, destPaths: s.destPaths, destAt: s.destAt, approaches: s.approaches }; });
const target = g.destAt.find((d) => d.startsWith(WHICH)) || g.destAt[0];
const m = /@(-?\d+),(-?\d+)\s+(\d+)m/.exec(target);
const DX = Number(m[1]), DZ = Number(m[2]), LEN = Number(m[3]);
console.log('ground ' + JSON.stringify(g));
console.log('target ' + target);

const map = await page.evaluate(([dx, dz, R]) => {
  const P = WALLY.ctx.city.pavedAt;
  const cells = [];
  for (let x = dx - R; x <= dx + R; x += 0.5)
    for (let z = dz - R; z <= dz + R; z += 0.5)
      if (P(x, z)) cells.push([+x.toFixed(1), +z.toFixed(1)]);
  return cells;
}, [DX, DZ, 90]);
console.log('paved cells within 90 m of the destination: ' + map.length);
/* ASCII, 2 m a character, so the shape is visible rather than asserted */
{
  const W = 46, cell = 4;
  const rows = [];
  for (let j = 0; j < W; j++) {
    let s = '';
    for (let i = 0; i < W; i++) {
      const x0 = DX - 90 + i * cell, z0 = DZ - 90 + j * cell;
      const hit = map.some(([x, z]) => x >= x0 && x < x0 + cell && z >= z0 && z < z0 + cell);
      const isDest = Math.abs(x0 + cell / 2 - DX) < cell && Math.abs(z0 + cell / 2 - DZ) < cell;
      s += isDest ? 'X' : hit ? '#' : '.';
    }
    rows.push(s);
  }
  console.log('\n  paved ground, 4 m a character, X = the destination:');
  for (const r of rows) console.log('   ' + r);
}
/* THE FAR END OF THE TRACK: the paved cell furthest from the
   destination that is still reachable along paved ground. */
/* THE TRACK'S OWN FAR END, not the furthest paving on the island:
   ground.js logged this track as LEN metres long, so its road end is
   the paved cell whose distance from the destination is closest to
   LEN. Taking the global maximum put the first run of this rig on a
   road 117 m away and it walked into a fence. */
const far = map.reduce((a, c) => {
  const d = Math.hypot(c[0] - DX, c[1] - DZ);
  const e = Math.abs(d - LEN);
  return e < a.e ? { x: c[0], z: c[1], d: +d.toFixed(1), e } : a; }, { e: 1e9 });
console.log('\nfurthest paved point from the destination: ' + JSON.stringify(far));
/* FACE FIRST, THEN TELEPORT. The follow camera re-seeds off his yaw
   when the controller is teleported, and the keys are resolved against
   the CAMERA — so setting the yaw after the teleport (what the last
   run did) leaves the lens pointing back down the hill, and the
   "aiming" walk that followed carried him 20 m off the track before
   the shutter. Face, teleport, let the boom settle, shoot. */
await page.evaluate(([x, z, dx, dz]) => {
  const c = WALLY.ctx;
  c.wally.setYaw(Math.atan2(dx - x, dz - z));
  WALLY.debug.physTeleport(x, c.world.heightAt(x, z) + 0.4, z);
}, [far.x, far.z, DX, DZ]);
await page.waitForTimeout(4000);
await page.screenshot({ path: 'shots/judge3/desire-start.png', timeout: 30000 });
/* CLOSED LOOP. Hold W and pulse A/D on the bearing error, which is how
   a player walks; setYaw() alone does nothing because the keys are
   resolved against the CAMERA. */
const track = [];
await page.keyboard.down('KeyW');
for (let i = 0; i < 26; i++) {
  const s = await page.evaluate(([dx, dz]) => {
    const c = WALLY.ctx, p = c.wally.position, cam = c.camera;
    const f = new WALLY.THREE.Vector3(); cam.getWorldDirection(f);
    const want = Math.atan2(dx - p.x, dz - p.z), have = Math.atan2(f.x, f.z);
    let e = want - have; while (e > Math.PI) e -= 2 * Math.PI; while (e < -Math.PI) e += 2 * Math.PI;
    return { x: +p.x.toFixed(1), z: +p.z.toFixed(1), err: +(e * 180 / Math.PI).toFixed(0),
      paved: c.city.pavedAt(p.x, p.z),
      side: Math.max(c.city.pavedAt(p.x + 5, p.z), c.city.pavedAt(p.x - 5, p.z),
        c.city.pavedAt(p.x, p.z + 5), c.city.pavedAt(p.x, p.z - 5)),
      to: +Math.hypot(p.x - dx, p.z - dz).toFixed(1) };
  }, [DX, DZ]);
  track.push(s);
  if (i === 8) await page.screenshot({ path: 'shots/judge3/desire-mid.png', timeout: 30000 });
  if (s.to < 8) break;
  if (i > 4 && Math.abs(s.to - track[i - 4].to) < 0.6) { console.log('  stuck at step ' + (i + 1) + ' — stopping'); break; }
  if (Math.abs(s.err) > 8) {
    const k = s.err > 0 ? 'KeyD' : 'KeyA';
    await page.keyboard.down(k); await page.waitForTimeout(Math.min(900, Math.abs(s.err) * 9)); await page.keyboard.up(k);
  }
  await page.waitForTimeout(500);
}
await page.keyboard.up('KeyW');
console.log(' step      x       z  err  paved  aside  m-to-go');
track.forEach((s, i) => console.log('  ' + String(i + 1).padStart(3) + '  ' + String(s.x).padStart(7)
  + ' ' + String(s.z).padStart(7) + ' ' + String(s.err).padStart(4) + '  ' + String(s.paved).padStart(5)
  + '  ' + String(s.side).padStart(5) + '  ' + String(s.to).padStart(7)));
console.log('  feet on the worn strip: ' + track.filter((s) => s.paved).length + '/' + track.length
  + '   ·   ground 5 m aside laid: ' + track.filter((s) => s.side).length + '/' + track.length);
console.log('  closed ' + (track[0].to - track[track.length - 1].to).toFixed(1) + ' m of a ' + LEN + ' m track');
await page.screenshot({ path: 'shots/judge3/desire-end.png', timeout: 30000 });
const errs = logs.filter((l) => l.startsWith('[PAGEERROR]'));
if (errs.length) console.log('ERRORS: ' + errs.slice(0, 5).join(' | '));
await close();
