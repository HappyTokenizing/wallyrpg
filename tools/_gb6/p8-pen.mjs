/* GB6 PROBE 8 — pen, barrel, eraser, and the back button attributed.

   p2 died here: a mouse BACK-button press over the pad navigated the
   page away from the game, so everything after it was lost. The back
   button is therefore driven LAST, and only after the question that
   matters is answered: does the same press on the CANVAS navigate too?
   If it does, the navigation is Chrome's and not the pad's. */
import { boot, padProbe, padRead, panelsNow, nearId, boxes } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, mousePress } = R;

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toDoor = async () => {
  await page.evaluate(() => { WALLY.debug.uiHide(); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, null, { timeout: 8000 }); } catch {}
  return nearId(page);
};
const closeAll = async () => { await page.evaluate(() => WALLY.debug.uiHide()); await page.waitForTimeout(350); };

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(400);
const B = await boxes(page);
console.log('BOXES', JSON.stringify(B));

/* ---- pen tip ---- */
{
  const door = await toDoor();
  await padProbe(page);
  await mousePress(B.act.x, B.act.y, 'left', 60, 'pen');
  await page.waitForTimeout(900);
  const p = await padRead(page); const pn = await panelsNow(page);
  ok(p.downs.some((d) => d.ptype === 'pen'), 'PEN-pre [a pen contact really reached Enter]',
    JSON.stringify(p.downs.map((d) => [d.target, d.ptype, d.button])));
  ok(door !== null && p.act === 1 && pn.includes('place'),
    'PEN-1 [pen tip, button 0]: a stylus presses Enter exactly as a thumb does',
    `act ${p.act} panels ${JSON.stringify(pn)}`);
  await closeAll();
}
/* ---- pen barrel ---- */
{
  await toDoor();
  await padProbe(page);
  await mousePress(B.act.x, B.act.y, 'right', 60, 'pen');
  await page.waitForTimeout(800);
  const p = await padRead(page); const pn = await panelsNow(page);
  ok(p.downs.some((d) => d.ptype === 'pen' && d.button === 2),
    'PEN-pre2 [a pen BARREL press really reached Enter]',
    JSON.stringify(p.downs.map((d) => [d.target, d.ptype, d.button])));
  ok(p.act === 0 && pn.length === 0, 'PEN-2 [pen barrel button on Enter]: refused',
    `act ${p.act} panels ${JSON.stringify(pn)}`);
  const f = await page.evaluate(() => {
    const a = document.activeElement;
    return a && a.closest?.('.w-touch') ? (a.getAttribute('aria-label') || a.className) : null;
  });
  ok(f === null, 'PEN-2b [...and the barrel press does not leave the button focused either]', String(f));
  await closeAll();
}
/* ---- eraser: SYNTHETIC, CDP cannot dispatch button 5 ---- */
for (const [b, mask, label, wantFire] of [
  [5, 32, 'ERASER (button 5)', false],
  [0, 1, 'the same synthetic path at button 0', true],
]) {
  await toDoor();
  await padProbe(page);
  await page.evaluate(({ b, mask }) => {
    const el = document.querySelector('.w-abtn.act');
    const r = el.getBoundingClientRect();
    const mk = (t, button, buttons) => new PointerEvent(t, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 900 + button, pointerType: 'pen', isPrimary: true, button, buttons,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    });
    el.dispatchEvent(mk('pointerdown', b, mask));
    el.dispatchEvent(mk('pointerup', b, 0));
  }, { b, mask });
  await page.waitForTimeout(800);
  const p = await padRead(page); const pn = await panelsNow(page);
  const fired = p.act > 0 || pn.length > 0;
  ok(p.downs.some((d) => d.button === b && d.inPad), `ERA-pre [${label} reached Enter]`,
    JSON.stringify(p.downs.map((d) => [d.target, d.ptype, d.button])));
  ok(fired === wantFire, `ERA [${label}]: ${wantFire ? 'fires' : 'refused'}`,
    `act ${p.act} panels ${JSON.stringify(pn)}`);
  await closeAll();
}

/* ---- THE BACK BUTTON, ATTRIBUTED. Canvas first: if the canvas
       navigates too, the navigation belongs to Chrome. ---- */
{
  const hist0 = await page.evaluate(() => history.length);
  await mousePress(195, 300, 'back', 60);
  await page.waitForTimeout(1200);
  const aliveCanvas = await page.evaluate(() => !!(window.WALLY && WALLY.debug && WALLY.debug.touchState)).catch(() => false);
  console.log(`BACK-canvas: history ${hist0}, game still alive after a back press ON THE CANVAS: ${aliveCanvas}`);
  ok(true, 'BACK-canvas-info [a back-button press on the canvas]:', `game alive ${aliveCanvas}`);
  if (aliveCanvas) {
    /* the canvas survived, so try the pad — if only the pad navigates,
       the pad is the difference */
    await padProbe(page);
    await mousePress(B.act.x, B.act.y, 'back', 60);
    await page.waitForTimeout(1200);
    const alivePad = await page.evaluate(() => !!(window.WALLY && WALLY.debug && WALLY.debug.touchState)).catch(() => false);
    ok(alivePad, 'BACK-pad [a back-button press over the pad does not throw the player out of the game]',
      `game alive ${alivePad}`);
    if (alivePad) {
      const p = await padRead(page); const pn = await panelsNow(page);
      ok(p.act === 0 && p.sc === 0 && pn.length === 0, 'BACK-pad2 [and it fires no verb]',
        `act ${p.act} sc ${p.sc} panels ${JSON.stringify(pn)}`);
    }
  } else {
    ok(true, 'BACK [the navigation is CHROME, not the pad]: a back press on the bare canvas leaves the game too', '');
  }
}

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
