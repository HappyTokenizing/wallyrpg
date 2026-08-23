/* PROBE 8 — loose ends.
   1. A secondary button HELD, then the primary pressed: Chrome turns
      the second press into a pointermove, so nothing arms. Measure it
      rather than assume it.
   2. A right press with a sheet up (the pad is behind it).
   3. The minimal reproduction of the focus defect, stated on its own so
      it can be pasted into a bug: three events and one keystroke. */
import { boot, padProbe, padRead, panelsNow, nearId, boxes } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, mouseAt, mousePress, press } = R;

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toDoor = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, { timeout: 5000 }); } catch {}
  await page.waitForTimeout(300);
  return nearId(page);
};
const hush = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.ui.closeAll(); });
  await page.waitForTimeout(700);
};
const blur = () => page.evaluate(() => document.activeElement?.blur?.());
const active = () => page.evaluate(() => {
  const a = document.activeElement;
  return a === document.body ? 'BODY' : (a?.getAttribute?.('aria-label') || a?.tagName || null);
});

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(500);
const B = await boxes(page);

/* 1. right held, then a primary press */
const d1 = await toDoor();
await padProbe(page); await blur();
await mouseAt('mouseMoved', B.act.x, B.act.y);
await mouseAt('mousePressed', B.act.x, B.act.y, 'right', 2);
await page.waitForTimeout(90);
await mouseAt('mousePressed', B.act.x, B.act.y, 'left', 3);     // chorded: arrives as a move
await page.waitForTimeout(90);
await mouseAt('mouseReleased', B.act.x, B.act.y, 'left', 2);
await page.waitForTimeout(90);
await mouseAt('mouseReleased', B.act.x, B.act.y, 'right', 0);
await page.waitForTimeout(900);
let p = await padRead(page), pn = await panelsNow(page);
console.log('CH-info events', JSON.stringify(p.downs.map((x) => [x.target, x.button])),
  'ups', JSON.stringify(p.ups.map((x) => [x.target, x.button])));
ok(p.act === 0 && !pn.includes('place'),
  'CH-1 [right held, then the primary pressed on Enter]: nothing fires — Chrome sends the chorded primary as a pointermove, so the button never arms. Before the guard this same gesture fired off the right release.',
  `near ${d1}, act ${p.act}, panels ${JSON.stringify(pn)}`);
await hush(); await blur();

/* 2. a right press with a sheet up */
await page.evaluate(() => { WALLY.ctx.ui.openPhone(); });
await page.waitForTimeout(800);
await padProbe(page); await blur();
await mousePress(B.act.x, B.act.y, 'right', 60);
await page.waitForTimeout(500);
p = await padRead(page);
const fSheet = await active();
ok(p.act === 0, 'SH-1 [a right press where Enter would be, with the phone up]: nothing fires',
  `act ${p.act}, down ${JSON.stringify(p.down && [p.down.target, p.down.button, p.down.inPad])}, focus ${fSheet}`);
await hush(); await blur();

/* 3. THE MINIMAL REPRODUCTION */
const d3 = await toDoor();
await padProbe(page); await blur();
const before = { active: await active(), panels: await panelsNow(page),
  dlg: await page.evaluate(() => !!WALLY.ctx.ui.dialogueOpen) };
await mouseAt('mouseMoved', B.act.x, B.act.y);
await mouseAt('mousePressed', B.act.x, B.act.y, 'right', 2);
await mouseAt('mouseReleased', B.act.x, B.act.y, 'right', 0);
await page.waitForTimeout(250);
const mid = { active: await active(), panels: await panelsNow(page),
  act: (await padRead(page)).act };
await page.keyboard.press('Space');
await page.waitForTimeout(900);
p = await padRead(page); pn = await panelsNow(page);
const w = await page.evaluate(() => WALLY.debug.interact?.());
console.log('REPRO before', JSON.stringify(before));
console.log('REPRO after the right press', JSON.stringify(mid));
console.log('REPRO after Space', JSON.stringify({ act: p.act, panels: pn,
  clicks: p.clicks.map((c) => [c.target, c.detail]), why: w }));
ok(before.dlg === false && d3 !== null && mid.act === 0,
  'RP-pre [door in range, no card up, and the right press itself fired nothing]',
  `near ${d3}, ${JSON.stringify(mid)}`);
ok(p.act === 0 && !pn.includes('place'),
  'RP-1 [right press on Enter, then the SPACE bar]: the door must not open',
  `act ${p.act}, panels ${JSON.stringify(pn)}, why ${JSON.stringify(w)}`);

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
