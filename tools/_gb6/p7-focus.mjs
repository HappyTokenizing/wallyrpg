/* GB6 PROBE 7 — THE HOLE IN THE PRIMARY-BUTTON GATE, pinned down.

   p2 measured: a right or middle press on a pad BUTTON is correctly
   refused as a verb, and still FOCUSES the button, because `secondary(e)`
   returns above the `e.preventDefault()` whose own comment says it is
   there to stop the focus grab. The next Space or Enter keystroke is
   then delivered to that button as a click with detail 0 — the shape
   the pad accepts for keyboards and assistive technology — and the verb
   the gate just refused runs.

   This probe:
     1. reproduces it on the MENU button, which is the worst one: a
        right press plus a Space opens the pause sheet;
     2. re-runs the Jump case with a proper multi-frame sample, because
        p2's single read 400 ms later cannot see a 140 ms jumpHeld
        window on a machine running at a few frames a second;
     3. asks what the game's own keyboard does while a pad button holds
        focus — is Space still a jump?
     4. asks whether preventDefault on a SECONDARY pointerdown really
        suppresses the focus grab in this Chrome, so the report can name
        a fix that works rather than one that sounds right. Nothing is
        edited on disk: the experiment installs its own capture-phase
        listener, measures, and removes it. */
import { boot, padProbe, padRead, panelsNow, nearId, boxes } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, mousePress, mouseAt } = R;

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = async () => {
  await page.evaluate((b) => { WALLY.debug.uiHide(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
  await page.waitForTimeout(1200);
};
const toDoor = async () => {
  await page.evaluate(() => { WALLY.debug.uiHide(); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, null, { timeout: 8000 }); } catch {}
  return nearId(page);
};
const closeAll = async () => { await page.evaluate(() => WALLY.debug.uiHide()); await page.waitForTimeout(350); };
const blur = () => page.evaluate(() => document.activeElement?.blur?.());
const focusedLabel = () => page.evaluate(() => {
  const a = document.activeElement;
  return a && a.closest?.('.w-touch') ? (a.getAttribute('aria-label') || a.className) : null;
});
/* sample vy every 60 ms for `ms` and keep the peak — a starved frame
   loop can hide a jump entirely from a single read */
async function peakVy(ms = 1600) {
  let peak = -99;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(() => +WALLY.ctx.wally.controller.velocity.y.toFixed(2));
    if (v > peak) peak = v;
    await page.waitForTimeout(60);
  }
  return peak;
}

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(400);
const B = await boxes(page);
console.log('BOXES', JSON.stringify(B));

/* ---- 1. THE MENU BUTTON: a right press and a Space open the pause sheet ---- */
for (const [name, box, key] of [
  ['Menu', B.sc[3], 'Space'], ['Menu', B.sc[3], 'Enter'],
  ['Phone', B.sc[0], 'Space'], ['Desk', B.sc[2], 'Enter'],
]) {
  await toOpenGround();
  await blur();
  await padProbe(page);
  await mousePress(box.x, box.y, 'right', 70);
  await page.waitForTimeout(400);
  const f = await focusedLabel();
  await page.keyboard.press(key);
  await page.waitForTimeout(700);
  const p = await padRead(page);
  const pn = await panelsNow(page);
  ok(f !== null, `MIN-pre [${name}]: the refused right press left the pad button focused`, String(f));
  ok(p.sc === 0 && pn.length === 0,
    `MIN [${name} + ${key}]: a refused secondary press must not hand ${name}'s verb to the next keystroke`,
    `sc ${p.sc} panels ${JSON.stringify(pn)} focus ${f} detail0-clicks ${JSON.stringify(p.clicks.filter((c) => c.detail === 0).map((c) => c.target))}`);
  await closeAll();
}

/* ---- 2. JUMP, sampled properly ---- */
{
  await toOpenGround();
  await blur();
  /* control: the same keystroke with nothing focused */
  await page.keyboard.press('Space');
  const ctrlPeak = await peakVy(1500);
  await page.waitForTimeout(1200);
  await toOpenGround();
  await blur();
  await padProbe(page);
  await mousePress(B.jump.x, B.jump.y, 'right', 70);
  await page.waitForTimeout(300);
  const f = await focusedLabel();
  await page.keyboard.press('Space');
  const peak = await peakVy(1600);
  const p = await padRead(page);
  ok(f !== null, 'JMPF-pre [a right press on Jump left it focused]', String(f));
  console.log(`JMPF-info: Space with nothing focused peaked vy ${ctrlPeak}; with Jump focused peaked vy ${peak}`);
  ok(!(peak > 0.5 && ctrlPeak <= 0.5),
    'JMPF [right press on Jump, then Space]: does not jump off a button the gate refused',
    `peak vy ${peak} (control, nothing focused: ${ctrlPeak}) detail0-clicks ${JSON.stringify(p.clicks.filter((c) => c.detail === 0).map((c) => c.target))}`);
  await page.waitForTimeout(1200);
}

/* ---- 3. WHAT THE FOCUS COSTS THE GAME'S OWN KEYBOARD ---- */
{
  await toOpenGround();
  await blur();
  await mousePress(B.sc[0].x, B.sc[0].y, 'right', 70);   // Phone: its verb is a sheet
  await page.waitForTimeout(300);
  const f = await focusedLabel();
  await page.keyboard.press('Space');                     // the player means "jump"
  await page.waitForTimeout(600);
  const pn = await panelsNow(page);
  const peak = await peakVy(1200);
  ok(f !== null, 'KBD-pre [Phone holds focus]', String(f));
  ok(!pn.includes('phone'),
    'KBD [with a pad button focused, Space is still a jump and not that button]',
    `panels ${JSON.stringify(pn)} peak vy ${peak}`);
  await closeAll();
}

/* ---- 4. WOULD preventDefault ON THE REFUSED PRESS ACTUALLY FIX IT? ---- */
{
  await toOpenGround();
  await blur();
  await page.evaluate(() => {
    window.__pd = (e) => { if (e.button > 0) e.preventDefault(); };
    document.addEventListener('pointerdown', window.__pd, { capture: true, passive: false });
  });
  await mousePress(B.sc[3].x, B.sc[3].y, 'right', 70);
  await page.waitForTimeout(400);
  const f = await focusedLabel();
  await page.evaluate(() => document.removeEventListener('pointerdown', window.__pd, { capture: true }));
  ok(f === null,
    'FIX [preventDefault on a secondary pointerdown suppresses the focus grab in this Chrome]: so moving that one call above the gate would close it',
    `activeElement in pad: ${f}`);
  await closeAll();
}
/* ...and the control for the experiment itself: with the listener gone,
   the same press focuses again */
{
  await toOpenGround();
  await blur();
  await mousePress(B.sc[3].x, B.sc[3].y, 'right', 70);
  await page.waitForTimeout(400);
  const f = await focusedLabel();
  ok(f !== null, 'FIX-control [with the experiment removed the same press focuses again — the difference was the preventDefault]',
    String(f));
  await closeAll();
}

/* ---- 5. THE OTHER EARLY RETURN ABOVE THE SAME preventDefault ----
   bindPress's pointerdown has TWO returns above `e.preventDefault()`:
   the secondary gate, and `if (pressing.has(btn)) return` — one contact
   owns one button. So a SECOND thumb landing on an already-armed
   button skips the same call. Does it focus it, on plain touch, with
   no mouse anywhere? */
{
  await toDoor();
  await blur();
  await padProbe(page);
  const lx = B.act.x - 18, rx = B.act.x + 18;
  const pt = (id, x, y) => ({ x, y, id, radiusX: 14, radiusY: 14, force: 1 });
  await R.multi('touchStart', [pt(1, lx, B.act.y)]);
  await page.waitForTimeout(70);
  const fOne = await focusedLabel();
  await R.multi('touchStart', [pt(1, lx, B.act.y), pt(2, rx, B.act.y)]);
  await page.waitForTimeout(90);
  const fTwo = await focusedLabel();
  await R.multi('touchEnd', [pt(1, lx, B.act.y)]);
  await page.waitForTimeout(120);
  await R.multi('touchEnd', [pt(2, rx, B.act.y)]);
  await page.waitForTimeout(700);
  const fEnd = await focusedLabel();
  console.log(`SECOND-info: focus after one contact ${fOne}, after the second ${fTwo}, after both lift ${fEnd}`);
  ok(fOne === null, 'SECOND-a [one thumb on Enter leaves no focus — the press reached preventDefault]', String(fOne));
  ok(fTwo === null,
    'SECOND [a second thumb on an already-armed Enter leaves no focus either]',
    `after one ${fOne}, after two ${fTwo}, at the end ${fEnd}`);
  await closeAll();
}

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
