#!/usr/bin/env node
/* _ja-ladder.mjs — JUDGE RIG (throwaway). The altitude ladder, flown.
   Re-anchors x/z/yaw/alt before EVERY sample (balloon({alt}) teleports
   and then the flight model runs), and reports drawn / animated /
   noticing both as totals and binned by range from the lens, so the
   same table answers "at 90 m of altitude" and "at 90 m of range".
   A pavement-lens control is taken on the same page load. */
import { boot } from './_perf-lib.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const ALTS = [20, 40, 90, 150, 250];
const BINS = [20, 40, 90, 150, 250, 620];
const OUT = 'shots/judge3';
const logs = [];
const { page, close } = await boot({ w: 1600, h: 900, qs: '?skipIntro', logs });
await mkdir(OUT, { recursive: true });
await page.waitForTimeout(4500);

const ok = await page.evaluate(() => WALLY.debug.arrive('markethall'));
if (ok !== true) { console.error('arrive !== true:', ok); await close(); process.exit(2); }
const clock = await page.evaluate(() => {
  const t = WALLY.ctx.game.time; const want = 13 - (t.hour ?? 12);
  if (want > 0) t.advance(Math.round(want * 60), 0);
  return +(WALLY.ctx.game.time.hour).toFixed(2);
});
const HOME = await page.evaluate(() => {
  const c = WALLY.ctx, p = c.wally.position;
  let sx = 0, sz = 0, w = 0, n = 0;
  for (const h of c.npc.humans) { if (h.asleep) continue;
    const d = Math.hypot(h.root.position.x - p.x, h.root.position.z - p.z);
    if (d > 400 || d < 25) continue; const k = 1 / d;
    sx += h.root.position.x * k; sz += h.root.position.z * k; w += k; n++; }
  const yaw = n ? Math.atan2(sx / w - p.x, sz / w - p.z) : 0;
  c.wally.setYaw(yaw);
  return { x: p.x, z: p.z, yaw, n };
});
await page.waitForTimeout(2500);

const measure = async (alt, tag) => {
  const r = await page.evaluate(([a, bins]) => {
    const ctx = WALLY.ctx, cam = ctx.camera, npc = ctx.npc;
    cam.updateMatrixWorld();
    const camP = cam.position.clone(), wp = ctx.wally.position;
    const sky = WALLY.debug.skyCrowd();
    const gk = WALLY.debug.bubbleScene().gawk;
    const scratch = camP.clone();
    /* PER-BAND, by range FROM THE LENS. drawn = a person on the screen
       by either representation (h.root.visible, or one instance in the
       billboard call); animated = h.active, the only ones with a
       solved skeleton; noticing = gawkOn with the look actually
       blended in (skinned) or the sky crowd's own notice flag. */
    const band = bins.map(() => ({ n: 0, drawnSkin: 0, drawnSky: 0, anim: 0, notice: 0, inFrame: 0, px: 0 }));
    const bandOf = (d) => { for (let i = 0; i < bins.length; i++) if (d <= bins[i]) return i; return -1; };
    let awake = 0;
    for (const h of npc.humans) {
      if (h.asleep) continue; awake++;
      const p = h.root.position;
      const d = p.distanceTo(camP);
      const bi = bandOf(d); if (bi < 0) continue;
      const B = band[bi]; B.n++;
      if (h.root.visible) B.drawnSkin++;
      else if (h.airOn) B.drawnSky++;
      if (h.active) B.anim++;
      const looking = !!h.gawkOn && ((h.anim && h.anim.lookW > 0.3) || (!h.active && h.gawkW > 0.3));
      if (looking) B.notice++;
      const head = scratch.set(p.x, p.y + h.height, p.z).project(cam).clone();
      const feet = scratch.set(p.x, p.y, p.z).project(cam).clone();
      if (head.z > -1 && head.z < 1 && Math.abs(head.x) < 1 && Math.abs(head.y) < 1) {
        B.inFrame++;
        const px = Math.abs(head.y - feet.y) * 450;
        if (px > B.px) B.px = +px.toFixed(1);
      }
    }
    const dir = camP.clone(); cam.getWorldDirection(dir);
    const gy = ctx.world.heightAt(wp.x, wp.z);
    const P = window.__WALLY_PERF__ || {};
    return { ask: a, agl: +(wp.y - gy).toFixed(1), camY: +camP.y.toFixed(1),
      camAgl: +(camP.y - ctx.world.heightAt(camP.x, camP.z)).toFixed(1),
      back: +Math.hypot(camP.x - wp.x, camP.z - wp.z).toFixed(1),
      pitch: +(Math.asin(-dir.y) * 180 / Math.PI).toFixed(1),
      drift: +Math.hypot(wp.x - WALLY.__HX, wp.z - WALLY.__HZ).toFixed(1),
      flying: !!ctx.wally.flying, mode: sky.mode, reach: sky.reach,
      awake, skyDrawn: sky.drawn, skyCand: sky.candidates, skyNotice: sky.noticing,
      skin: npc.humans.filter((h) => h.root.visible).length,
      active: npc.humans.filter((h) => h.active).length,
      gawkOn: gk.on, looking: gk.looking, stopped: gk.stopped, pointing: gk.pointing,
      craneDeg: gk.craneDeg, calls: P.calls ?? 0, tris: P.tris ?? 0, fps: P.fps ?? 0,
      band };
  }, [alt, BINS]);
  r.tag = tag; return r;
};

await page.evaluate(([x, z]) => { WALLY.__HX = x; WALLY.__HZ = z; }, [HOME.x, HOME.z]);
const rows = [];
rows.push(await measure(-1, 'pavement'));      // the control, on his own legs

await page.evaluate(() => { try { WALLY.ctx.game.actions.grantRide('balloon'); } catch (e) {} });
await page.waitForTimeout(2500);

const AIM = new Map();
const hold = async (alt) => {
  const found = await page.evaluate(([a, hx, hz, pre]) => {
    const c = WALLY.ctx;
    WALLY.debug.balloon({ at: [hx, c.world.heightAt(hx, hz) + a + 6, hz] });
    if (pre !== null) { c.wally.setYaw(pre); WALLY.debug.balloon({ alt: a }); return pre; }
    let best = 0, bestN = -1;
    const near = Math.max(60, a * 2.2), far = Math.max(240, a * 5);
    const gy = c.world.heightAt(hx, hz);
    for (let d = 0; d < 72; d++) {
      const yaw = (d * 5) * Math.PI / 180, fx = Math.sin(yaw), fz = Math.cos(yaw);
      let blocked = false;
      for (let s = 12; s <= 40; s += 14)
        if (c.world.heightAt(hx - fx * s, hz - fz * s) > gy + a * 0.55) { blocked = true; break; }
      if (blocked) continue;
      let n = 0;
      for (const h of c.npc.humans) { if (h.asleep) continue;
        const dx = h.root.position.x - hx, dz = h.root.position.z - hz, r = Math.hypot(dx, dz);
        if (r < near || r > far) continue;
        if ((dx * fx + dz * fz) / r < 0.927) continue; n++; }
      if (n > bestN) { bestN = n; best = yaw; }
    }
    c.wally.setYaw(best); WALLY.debug.balloon({ alt: a });
    return best;
  }, [alt, HOME.x, HOME.z, AIM.has(alt) ? AIM.get(alt) : null]);
  if (!AIM.has(alt)) AIM.set(alt, found);
  await page.waitForTimeout(500);
  await page.evaluate((a) => { WALLY.debug.balloon({ alt: a }); }, alt);
  await page.waitForTimeout(1100);
};

for (const alt of ALTS) {
  await hold(alt);
  await page.waitForTimeout(3200);
  await hold(alt);                       // re-anchor immediately before the sample
  await page.waitForTimeout(3600);
  await hold(alt);
  rows.push(await measure(alt, 'on'));
  await page.screenshot({ path: join(OUT, `alt-${alt}.png`), timeout: 30000 });
  await page.evaluate(() => WALLY.debug.skyCrowd('off'));
  await page.waitForTimeout(2600);
  await hold(alt);
  rows.push(await measure(alt, 'off'));
  await page.screenshot({ path: join(OUT, `alt-${alt}-off.png`), timeout: 30000 });
  await page.evaluate(() => WALLY.debug.skyCrowd('on'));
  await page.waitForTimeout(1200);
}

console.log('home', JSON.stringify(HOME), 'clock', clock);
console.log('\ntag       ask  agl camAgl back  pitch drift fly mode reach awake drawn skin  sky anim notice stop pnt calls  tris   fps');
for (const r of rows) {
  const drawn = r.skin + r.skyDrawn;
  console.log(String(r.tag).padEnd(9), String(r.ask < 0 ? '-' : r.ask).padStart(4),
    String(r.agl).padStart(5), String(r.camAgl).padStart(6), String(r.back).padStart(5),
    String(r.pitch).padStart(6), String(r.drift).padStart(5), String(r.flying ? 'Y' : 'n').padStart(3),
    String(r.mode).padStart(4), String(r.reach).padStart(6), String(r.awake).padStart(5),
    String(drawn).padStart(5), String(r.skin).padStart(4), String(r.skyDrawn).padStart(4),
    String(r.active).padStart(4), String(r.looking).padStart(6), String(r.stopped).padStart(4),
    String(r.pointing).padStart(3), String(r.calls).padStart(5),
    String((r.tris / 1000) | 0).padStart(5) + 'k', String(r.fps).padStart(5));
}
console.log('\nBY RANGE FROM THE LENS  (band = people whose distance from the camera is <= the label)');
console.log('row            band     n  drawn(skin+sky)  animated  noticing  inFrame  tallestPx');
for (const r of rows) {
  for (let i = 0; i < BINS.length; i++) {
    const B = r.band[i]; if (!B.n) continue;
    console.log((r.tag + ' ' + (r.ask < 0 ? 'foot' : r.ask + 'm')).padEnd(14),
      String(BINS[i]).padStart(4), String(B.n).padStart(5),
      String(B.drawnSkin + B.drawnSky).padStart(8) + ' (' + B.drawnSkin + '+' + B.drawnSky + ')',
      String(B.anim).padStart(9), String(B.notice).padStart(9),
      String(B.inFrame).padStart(8), String(B.px).padStart(10));
  }
}
for (const r of rows) if (r.craneDeg && r.craneDeg.length) console.log(r.tag, r.ask, 'craneDeg', JSON.stringify(r.craneDeg));
const errs = logs.filter((l) => l.startsWith('[PAGEERROR]'));
if (errs.length) console.log('\nERRORS:\n' + errs.slice(0, 8).join('\n'));
await close();
