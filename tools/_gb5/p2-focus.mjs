/* PROBE 2 — WHAT THE GUARD COSTS AT THE TOP OF THE HANDLER.

   The guard is the FIRST statement in every pointerdown handler, and
   `e.preventDefault()` is several lines below it. The comment on that
   call says what it is for: "this stops the focus grab". So a refused
   secondary press no longer prevents anything — and a <button> that a
   mouse pressed and that nobody prevented is a <button> that now has
   FOCUS. Every pad button also carries a detail-0 click listener, on
   purpose, for keyboards and screen readers.

   If both of those are true then a right press on Enter arms the
   keyboard: the next Space or Enter keystroke is delivered to the
   focused button instead of to the game. */
import { boot, padProbe, padRead, panelsNow, nearId, boxes } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, mouseAt, mousePress, press } = R;

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = () => page.evaluate((b) => {
  WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {});
}, BOOT);
const toDoor = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, { timeout: 5000 }); } catch {}
  await page.waitForTimeout(300);
  return nearId(page);
};
const closeAll = async () => { await page.evaluate(() => WALLY.ctx.ui.closeAll()); await page.waitForTimeout(400); };
const active = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a) return null;
  return (a.getAttribute?.('aria-label') || a.tagName) + (a.className ? '.' + String(a.className).trim().split(/\s+/).join('.') : '');
});
const blur = () => page.evaluate(() => document.activeElement?.blur?.());

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(500);
const B = await boxes(page);

/* --- CONTROL: what a FINGER leaves behind. The primary path reaches
       e.preventDefault(), so nothing should be focused. --- */
await toDoor();
await blur();
await padProbe(page);
await press(B.act.x, B.act.y, 60);
await page.waitForTimeout(700);
const afterFinger = await active();
ok(afterFinger === 'BODY' || afterFinger === null,
  'F0 [control: a finger tap leaves nothing focused]', `activeElement ${afterFinger}`);
await closeAll();

/* --- the refused presses --- */
for (const [btn, tag] of [['right', 'R'], ['middle', 'M']]) {
  for (const [name, box, sel] of [['Enter', B.act, '.w-abtn.act'], ['Jump', B.jump, '.w-abtn.jump'],
    ['Phone', B.sc[0], null], ['Menu', B.sc[3], null], ['Stick', B.stick, null]]) {
    await toOpenGround(); await page.waitForTimeout(400);
    await blur();
    await mousePress(box.x, box.y, btn, 60);
    await page.waitForTimeout(400);
    const a = await active();
    ok(a === 'BODY' || a === null,
      `${tag}1 [${btn} press on ${name} leaves nothing focused]`, `activeElement ${a}`);
    await blur();
  }
}

/* --- AND THE CONSEQUENCE, if anything above focused. Right-press
       Enter, then press SPACE. Space is the game's JUMP. If the button
       took focus, the browser delivers Space to it as a detail-0 click
       and the pad's assistive-technology listener runs the verb. --- */
const doorS = await toDoor();
await blur();
await padProbe(page);
await mousePress(B.act.x, B.act.y, 'right', 60);
await page.waitForTimeout(300);
const focused = await active();
await page.keyboard.press('Space');
await page.waitForTimeout(900);
let p = await padRead(page); let pn = await panelsNow(page);
ok(doorS !== null, 'S-pre [at the apartment door]', `near ${doorS}`);
ok(p.act === 0 && !pn.includes('place'),
  'S1 [right press on Enter, then SPACE]: the keystroke does NOT open the door',
  `focused after the right press: ${focused}; act ${p.act}, panels ${JSON.stringify(pn)}, clicks ${JSON.stringify(p.clicks.map((c) => [c.target, c.detail]))}`);
await closeAll(); await blur();

/* --- ...and the same with the ENTER key --- */
const doorE = await toDoor();
await blur();
await padProbe(page);
await mousePress(B.act.x, B.act.y, 'right', 60);
await page.waitForTimeout(300);
const focused2 = await active();
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
p = await padRead(page); pn = await panelsNow(page);
ok(p.act === 0 && !pn.includes('place'),
  'S2 [right press on Enter, then the ENTER key]: the keystroke does NOT open the door',
  `focused ${focused2}; act ${p.act}, panels ${JSON.stringify(pn)}, clicks ${JSON.stringify(p.clicks.map((c) => [c.target, c.detail]))}`);
await closeAll(); await blur();

/* --- Jump: right press, then SPACE. If Jump took focus the space bar
       both jumps AND activates the button; either way we can see it. --- */
await toOpenGround(); await page.waitForTimeout(900);
await blur();
await mousePress(B.jump.x, B.jump.y, 'right', 60);
await page.waitForTimeout(300);
const focused3 = await active();
ok(true, 'S3-info [what a right press on Jump focused]', String(focused3));
await blur();

/* --- and the same question for a MIDDLE press on a shortcut: does the
       next Space/Enter open the phone? --- */
await toOpenGround(); await page.waitForTimeout(400);
await blur();
await padProbe(page);
await mousePress(B.sc[0].x, B.sc[0].y, 'middle', 60);
await page.waitForTimeout(300);
const focused4 = await active();
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
p = await padRead(page); pn = await panelsNow(page);
ok(p.sc === 0 && pn.length === 0,
  'S4 [middle press on Phone, then the ENTER key]: the keystroke does not open the phone',
  `focused ${focused4}; sc ${p.sc}, panels ${JSON.stringify(pn)}`);
await closeAll(); await blur();

/* --- AND THE POSITIVE CONTROL for the AT path, so S1/S2/S4 cannot pass
       by the keyboard being dead. Focus Enter on purpose and press
       it: this is the population the detail-0 listener exists for. --- */
const doorK = await toDoor();
await padProbe(page);
const gotFocus = await page.evaluate(() => {
  const b = document.querySelector('.w-abtn.act'); b.focus(); return document.activeElement === b;
});
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
p = await padRead(page); pn = await panelsNow(page);
ok(gotFocus && doorK !== null && p.act === 1 && pn.includes('place'),
  'S5 [positive control: Enter deliberately focused, then the ENTER key]: opens the door',
  `focus ${gotFocus}, act ${p.act}, panels ${JSON.stringify(pn)}`);
await closeAll(); await blur();

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
