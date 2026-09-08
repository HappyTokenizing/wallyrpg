#!/usr/bin/env node
import { boot } from './_perf-lib.mjs';
const logs = [];
const { page, close } = await boot({ w: 1600, h: 900, qs: '?skipIntro', logs });
await page.waitForTimeout(4500);
await page.evaluate(() => WALLY.debug.arrive('mainstreet'));
await page.evaluate(() => { const t = WALLY.ctx.game.time; const w = 13 - (t.hour ?? 12); if (w > 0) t.advance(Math.round(w * 60), 0); });
await page.waitForTimeout(3000);
await page.evaluate(() => {
  const b = WALLY.ctx.npc.bubbles, orig = b.show.bind(b);
  WALLY.__CALLS = 0; WALLY.__OK = []; WALLY.__REJ = [];
  b.show = (h, text, o) => { WALLY.__CALLS++; const r = orig(h, text, o);
    (r ? WALLY.__OK : WALLY.__REJ).push(text); return r; };
});
const probe = async (tag) => {
  const r = await page.evaluate(() => {
    const c = WALLY.ctx, cam = c.camera; cam.updateMatrixWorld();
    const cp = cam.position.clone(); const fwd = new WALLY.THREE.Vector3(); cam.getWorldDirection(fwd);
    let inBand = 0, inFront = 0, eligible = 0; const ds = [];
    for (const h of c.npc.humans) {
      if (h.asleep) continue;
      const d = h.root.position.distanceTo(cp);
      if (d < 40) ds.push(+d.toFixed(1));
      if (d > 5 && d < 22) { inBand++;
        const dot = ((h.root.position.x - cp.x) * fwd.x + (h.root.position.z - cp.z) * fwd.z) / d;
        if (dot >= 0.30) { inFront++;
          if (h.active && h.root.visible && !h.isClient && !h.mayorDriven) eligible++; } }
    }
    ds.sort((a, b) => a - b);
    return { inBand, inFront, eligible, nearest: ds.slice(0, 6),
      calls: WALLY.__CALLS, ok: WALLY.__OK.length, rej: WALLY.__REJ.length,
      modal: !!(c.ui?.modal || c.ui?.dialogueOpen),
      used: WALLY.debug.bubbleScene().used, scene: WALLY.debug.bubbleScene().scene };
  });
  console.log(tag, JSON.stringify(r));
};
await probe('t=0 standing');
for (let i = 0; i < 8; i++) {
  await page.keyboard.down('KeyW'); await page.waitForTimeout(2200); await page.keyboard.up('KeyW');
  await page.keyboard.press(i % 2 ? 'KeyA' : 'KeyD'); await page.waitForTimeout(1600);
  await probe('walk ' + (i + 1));
}
const out = await page.evaluate(() => ({ ok: WALLY.__OK, rej: WALLY.__REJ, calls: WALLY.__CALLS }));
console.log('\nSHOWN:'); out.ok.forEach((t, i) => console.log(' ', i + 1, t));
console.log('REJECTED BY bubbles.show():'); out.rej.forEach((t) => console.log('  x', t));
console.log('\nforced: ' + JSON.stringify(await page.evaluate(() => WALLY.debug.bubbles(3))));
console.log('after force calls=' + JSON.stringify(await page.evaluate(() => ({ c: WALLY.__CALLS, ok: WALLY.__OK.length, rej: WALLY.__REJ.length }))));
await close();
