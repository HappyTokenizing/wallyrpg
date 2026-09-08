#!/usr/bin/env node
/* _ja-walk.mjs — JUDGE RIG. Two walks on one page load.
   A: walk Main Street on the real keys and read a dozen overheard
      claims, checking every price against the board AT THE MOMENT IT
      WAS SAID (economy.fmt(economy.price(tick)) — the market screen's
      own string), not against the base value.
   B: walk one desire path to a destination, on foot, and shoot it from
      the follow lens and from a pavement lens. */
import { boot } from './_perf-lib.mjs';
import { mkdir } from 'node:fs/promises';
const logs = [];
const { page, close } = await boot({ w: 1600, h: 900, qs: '?skipIntro', logs });
await mkdir('shots/judge3', { recursive: true });
await page.waitForTimeout(4500);

/* ---------------- A. THE CLAIMS ---------------- */
await page.evaluate(() => WALLY.debug.arrive('mainstreet'));
await page.evaluate(() => { const t = WALLY.ctx.game.time; const w = 13 - (t.hour ?? 12); if (w > 0) t.advance(Math.round(w * 60), 0); });
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const b = WALLY.ctx.npc.bubbles, orig = b.show.bind(b);
  WALLY.__SAID = [];
  b.show = (h, text, o) => {
    const r = orig(h, text, o);
    if (r && text) {
      const e = WALLY.ctx.game?.economy;
      const ticks = (text.match(/\b[A-Z][A-Z0-9]{1,5}\b/g) || []);
      const board = {};
      for (const t of ticks) { try { const v = e.price(t); if (Number.isFinite(v) && v > 0) board[t] = e.fmt(v); } catch (x) {} }
      WALLY.__SAID.push({ text, board,
        hour: +(WALLY.ctx.game.time.hour).toFixed(2),
        zone: WALLY.ctx.world.zoneAt ? WALLY.ctx.world.zoneAt(h.root.position.x, h.root.position.z) : null,
        d: +h.root.position.distanceTo(WALLY.ctx.wally.position).toFixed(1) });
    }
    return r;
  };
  return true;
});
const t0 = Date.now();
for (let i = 0; i < 26 && (await page.evaluate(() => WALLY.__SAID.length)) < 14; i++) {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2600);
  await page.keyboard.up('KeyW');
  await page.keyboard.press(i % 2 ? 'KeyA' : 'KeyD');
  await page.waitForTimeout(1400);
}
const said = await page.evaluate(() => WALLY.__SAID);
const walkS = ((Date.now() - t0) / 1000) | 0;
console.log(`A. ${said.length} lines overheard in ${walkS} s of walking Main Street at 13:00\n`);
let withPrice = 0, bad = 0;
said.forEach((s, i) => {
  const nums = s.text.match(/\$?\d[\d,]*/g) || [];
  const ticks = Object.keys(s.board);
  let verdict = '';
  if (nums.length && ticks.length) {
    withPrice++;
    const okAll = nums.every((n) => ticks.some((t) => s.board[t] === n || s.board[t] === n.replace('$', '')));
    if (!okAll) { bad++; verdict = '   <<< PRICE DOES NOT MATCH THE BOARD'; }
    else verdict = '   price == board';
  }
  console.log(String(i + 1).padStart(3) + '. ' + s.text);
  console.log('      board ' + JSON.stringify(s.board) + '  hour ' + s.hour + '  ' + s.d + ' m away' + verdict);
});
console.log(`\n   ${withPrice} of ${said.length} quoted the board; ${bad} disagreed with it`);
console.log('   braces reaching the screen: ' + said.filter((s) => s.text.includes('{')).length);

/* ---------------- B. THE DESIRE PATH ---------------- */
const g = await page.evaluate(() => {
  const s = WALLY.ctx.city.groundStats;
  return { desirePaths: s.desirePaths, destPaths: s.destPaths, destAt: s.destAt,
    approaches: s.approaches, kerbMetres: s.kerbMetres, destTris: s.destTris };
});
console.log('\nB. ground: ' + JSON.stringify(g));

/* WALK THE TRACK TO THE MINE HEAD. Put him at the ROAD end and walk
   him up it on the real keys; sample where his feet are against the
   worn strip so the claim is "he walked it", not "he was placed on
   it". pavedAt() is ground.js's own record of what it laid. */
const target = g.destAt.find((d) => d.startsWith('adit')) || g.destAt[0];
const m = /@(-?\d+),(-?\d+)\s+(\d+)m/.exec(target);
const DX = Number(m[1]), DZ = Number(m[2]);
const start = await page.evaluate(([dx, dz]) => {
  const c = WALLY.ctx;
  /* the road end: back off along the line to the nearest paved point */
  let best = null;
  for (let a = 0; a < 360; a += 5) {
    const rad = a * Math.PI / 180;
    for (let r = 30; r <= 140; r += 4) {
      const x = dx + Math.sin(rad) * r, z = dz + Math.cos(rad) * r;
      if (c.city.pavedAt && c.city.pavedAt(x, z) > 0.5) { if (!best || r < best.r) best = { x, z, r }; }
    }
  }
  const p = best || { x: dx + 90, z: dz, r: 90 };
  c.wally.position.set(p.x, c.world.heightAt(p.x, p.z), p.z);
  c.wally.setYaw(Math.atan2(dx - p.x, dz - p.z));
  return { x: +p.x.toFixed(1), z: +p.z.toFixed(1), r: +(p.r ?? 0).toFixed(0), dx, dz };
}, [DX, DZ]);
await page.waitForTimeout(2500);
await page.screenshot({ path: 'shots/judge3/desire-start.png', timeout: 30000 });
const track = [];
for (let i = 0; i < 14; i++) {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1200);
  await page.keyboard.up('KeyW');
  const s = await page.evaluate(([dx, dz]) => {
    const c = WALLY.ctx, p = c.wally.position;
    return { x: +p.x.toFixed(1), z: +p.z.toFixed(1),
      paved: c.city.pavedAt ? +c.city.pavedAt(p.x, p.z).toFixed(2) : null,
      toDest: +Math.hypot(p.x - dx, p.z - dz).toFixed(1) };
  }, [DX, DZ]);
  track.push(s);
  if (s.toDest < 12) break;
}
console.log('   walked from ' + JSON.stringify(start) + ' toward ' + target);
console.log('   step  x       z      pavedAt  m-to-destination');
track.forEach((s, i) => console.log('   ' + String(i + 1).padStart(4) + '  ' + String(s.x).padStart(7)
  + ' ' + String(s.z).padStart(7) + '  ' + String(s.paved).padStart(7) + '  ' + String(s.toDest).padStart(6)));
console.log('   on a laid surface for ' + track.filter((s) => s.paved > 0.3).length + ' of ' + track.length + ' samples');
await page.screenshot({ path: 'shots/judge3/desire-walked.png', timeout: 30000 });
/* AND FROM A PAVEMENT LENS — the same track seen from a person's eye
   height on the road it leaves, which is the view the claim is about. */
await page.evaluate(([dx, dz, sx, sz]) => {
  const c = WALLY.ctx;
  c.wally.position.set(sx, c.world.heightAt(sx, sz), sz);
  c.wally.setYaw(Math.atan2(dx - sx, dz - sz));
}, [DX, DZ, start.x, start.z]);
await page.waitForTimeout(2500);
await page.screenshot({ path: 'shots/judge3/desire-pavement.png', timeout: 30000 });
const errs = logs.filter((l) => l.startsWith('[PAGEERROR]'));
if (errs.length) console.log('\nERRORS:\n' + errs.slice(0, 6).join('\n'));
await close();
