#!/usr/bin/env node
/* _ja-walk2.mjs — JUDGE RIG. Walk TOWARD the crowd (the first rig
   walked in a straight line and heard nothing, which measures my
   steering, not the feature), and read every line actually spoken —
   checking each printed price against the board AT THE MOMENT IT WAS
   SAID, with economy.fmt, which is the string the market screen uses. */
import { boot } from './_perf-lib.mjs';
const logs = [];
const { page, close } = await boot({ w: 1600, h: 900, qs: '?skipIntro', logs });
await page.waitForTimeout(4500);
await page.evaluate(() => WALLY.debug.arrive('markethall'));
await page.evaluate(() => { const t = WALLY.ctx.game.time; const w = 13 - (t.hour ?? 12); if (w > 0) t.advance(Math.round(w * 60), 0); });
await page.waitForTimeout(3000);
await page.evaluate(() => {
  const b = WALLY.ctx.npc.bubbles, orig = b.show.bind(b);
  WALLY.__SAID = [];
  b.show = (h, text, o) => {
    const r = orig(h, text, o);
    if (r && text && !(o && o.key)) {
      const e = WALLY.ctx.game?.economy;
      const board = {};
      for (const t of (text.match(/\b[A-Z][A-Z0-9]{1,5}\b/g) || []))
        { try { const v = e.price(t); if (Number.isFinite(v) && v > 0) board[t] = e.fmt(v); } catch (x) {} }
      WALLY.__SAID.push({ text, board, hour: +(WALLY.ctx.game.time.hour).toFixed(2),
        d: +h.root.position.distanceTo(WALLY.ctx.wally.position).toFixed(1) });
    }
    return r;
  };
});
/* FACE THE NEAREST PERSON HE HAS NOT ALREADY HEARD, then walk. */
const t0 = Date.now();
let steps = 0;
while (steps < 90 && (await page.evaluate(() => WALLY.__SAID.length)) < 12) {
  await page.evaluate(() => {
    const c = WALLY.ctx, p = c.wally.position;
    let best = null, bd = 1e9;
    for (const h of c.npc.humans) { if (h.asleep) continue;
      const d = h.root.position.distanceTo(p);
      if (d < 9 || d > 90) continue;
      if (d < bd) { bd = d; best = h; } }
    if (best) c.wally.setYaw(Math.atan2(best.root.position.x - p.x, best.root.position.z - p.z));
  });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(1600);
  steps++;
}
const said = await page.evaluate(() => WALLY.__SAID);
console.log(`${said.length} lines overheard in ${((Date.now() - t0) / 1000) | 0} s of walking toward the crowd at Market Hall, 13:00\n`);
let quoted = 0, bad = 0;
said.forEach((s, i) => {
  const nums = s.text.match(/\d[\d,]*/g) || [];
  const ticks = Object.keys(s.board);
  let v = '';
  if (nums.length && ticks.length) { quoted++;
    const good = nums.every((n) => ticks.some((t) => s.board[t] === n));
    if (!good) { bad++; v = '   <<< DOES NOT MATCH THE BOARD'; } else v = '   price == board'; }
  console.log(String(i + 1).padStart(3) + '. "' + s.text + '"');
  console.log('      ' + s.d + ' m · board ' + JSON.stringify(s.board) + v);
});
console.log(`\n${quoted} quoted a live price, ${bad} disagreed with the board`);
console.log('braces on screen: ' + said.filter((s) => s.text.includes('{')).length
  + ' · distinct lines: ' + new Set(said.map((s) => s.text)).size + '/' + said.length);
await close();
