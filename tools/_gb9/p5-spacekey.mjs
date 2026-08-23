/* ROUND SEVEN, PROBE 5 — DISCRIMINATOR.
   Does a bare Space jump on mobile, or was p4's control a rig artefact?
   wally.js reads jump as a LEVEL (`o.jump = !!keys.Space`), so a press
   shorter than a frame can be invisible. Vary the hold and see. */
import { boot } from '../_gb7/lib.mjs';
import { peakVy, closeAll } from './lib9.mjs';

const t = await boot();
const { page, ok } = t;
await closeAll(page);

async function grounded(page, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(() => {
      const c = WALLY.ctx.wally?.controller; const v = c && (c.velocity || c.vel);
      return v ? Math.abs(v.y) : null;
    });
    if (v !== null && v < 0.08) return true;
    await page.waitForTimeout(120);
  }
  return false;
}

/* who owns the input right now? */
console.log('INPUT OWNER', JSON.stringify(await page.evaluate(() => ({
  touchEnabled: WALLY.ctx.ui.touch?.enabled ?? WALLY.debug.touchState().enabled,
  hasKeyboardInput: typeof WALLY.ctx.wally?.keyboardInput === 'function',
}))));

for (const hold of [0, 40, 100, 200, 400]) {
  const peaks = [];
  for (let i = 0; i < 5; i++) {
    await grounded(page);
    const pv = peakVy(page, 900);
    if (hold === 0) await page.keyboard.press('Space');
    else { await page.keyboard.down('Space'); await page.waitForTimeout(hold); await page.keyboard.up('Space'); }
    peaks.push((await pv).peak);
  }
  const hits = peaks.filter(x => x > 1).length;
  ok(hold === 0 || hits >= 4, `SPACE hold=${hold}ms jumps ${hits}/5`, JSON.stringify(peaks));
}

/* and the same for the WASD level-read, as a second witness that the
   keyboard reaches the game at all on this mobile context */
await grounded(page);
await page.keyboard.down('KeyW');
await page.waitForTimeout(600);
const sp = await page.evaluate(() => {
  const c = WALLY.ctx.wally?.controller; const v = c && (c.velocity || c.vel);
  return v ? +Math.hypot(v.x, v.z).toFixed(2) : null;
});
await page.keyboard.up('KeyW');
ok(sp > 0.5, 'W walks him on the mobile context (keyboard reaches the game)', `speed=${sp}`);

console.log(`FAILS ${t.fails}`);
await t.close();
