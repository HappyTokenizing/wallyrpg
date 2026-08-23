/* GB6 PROBE 6 — the loose ends the chord sweep raised.

   1. THE WINDOW INSIDE A CHORD. The stick's release is deliberately
      ungated so the final button-2 pointerup can free it. But Chrome
      delivers the PRIMARY release as a pointermove, so between the
      thumb button coming up and the secondary one coming up the stick
      is still armed and still following the mouse with no primary
      button held. Sample INSIDE that window rather than after it.
   2. DURATION. The pad has no duration gate, so a slow press must
      still press: 250 ms, 700 ms (past the platform long-press, where
      Chrome normally withholds the compatibility click) and 1500 ms.
   3. A CONTEXTMENU RAISED OVER THE PAD WHILE THE CONTROLS ARE FADED —
      the pad is pointer-events:none there, so the target is the canvas
      and a different owner decides.
*/
import { boot, padProbe, padRead, panelsNow, nearId, boxes, clsDown } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, mouseAt, touch, press } = R;
const MASKB = { left: 1, middle: 4, right: 2 };

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
const stickNow = () => page.evaluate(() => ({
  t: +WALLY.debug.touchState().t.toFixed(2),
  live: document.querySelector('.w-stick')?.classList.contains('live') ?? null,
  sp: +Math.hypot(WALLY.ctx.wally.controller.velocity.x, WALLY.ctx.wally.controller.velocity.z).toFixed(2),
}));

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(400);
const B = await boxes(page);
console.log('BOXES', JSON.stringify(B));

/* ---- 1. INSIDE THE CHORD ---- */
for (const second of ['right', 'middle']) {
  await toOpenGround();
  let mask = 0;
  await mouseAt('mouseMoved', B.stick.x, B.stick.y, 'none', 0);
  mask |= MASKB.left;
  await mouseAt('mousePressed', B.stick.x, B.stick.y, 'left', mask);
  for (let k = 1; k <= 4; k++) {
    await mouseAt('mouseMoved', B.stick.x, B.stick.y - k * 18, 'none', mask);
    await page.waitForTimeout(30);
  }
  const armed = await stickNow();
  mask |= MASKB[second];
  await mouseAt('mousePressed', B.stick.x, B.stick.y - 72, second, mask);
  await page.waitForTimeout(60);
  mask &= ~MASKB.left;
  await mouseAt('mouseReleased', B.stick.x, B.stick.y - 72, 'left', mask);   // arrives as a pointermove
  await page.waitForTimeout(350);
  const insideWindow = await stickNow();
  /* and it still tracks a mouse with no primary button down */
  await mouseAt('mouseMoved', B.stick.x + 60, B.stick.y - 72, 'none', mask);
  await page.waitForTimeout(250);
  const steered = await page.evaluate(() => WALLY.debug.touchState());
  mask &= ~MASKB[second];
  await mouseAt('mouseReleased', B.stick.x + 60, B.stick.y - 72, second, mask);
  await page.waitForTimeout(700);
  const after = await stickNow();
  ok(armed.t > 0.5, `CHW-pre [${second}]: the primary drag really deflected the stick first`, JSON.stringify(armed));
  ok(true, `CHW-info [${second}]: INSIDE the chord, primary already released =`,
    `${JSON.stringify(insideWindow)} then steered to x ${steered.x.toFixed(2)} t ${steered.t.toFixed(2)}`);
  ok(after.t === 0 && after.live === false,
    `CHW [${second}]: the stick is released by the SECONDARY pointerup that ends the chord — nothing is stranded`,
    JSON.stringify(after));
}

/* ---- 2. DURATION ---- */
for (const hold of [250, 700, 1500]) {
  const door = await toDoor();
  await padProbe(page);
  await touch('touchStart', B.act.x, B.act.y);
  await page.waitForTimeout(hold);
  await touch('touchEnd', B.act.x, B.act.y);
  await page.waitForTimeout(900);
  const p = await padRead(page); const pn = await panelsNow(page);
  ok(door !== null && p.act === 1 && pn.includes('place'),
    `HOLD-${hold} [a ${hold} ms press on Enter]: the pad has no duration gate and the door opens`,
    `act ${p.act} panels ${JSON.stringify(pn)} clicks ${JSON.stringify(p.clicks.map((c) => [c.target, c.detail]))}`);
  await closeAll();
}
/* the same on the canvas, where the trap lives: a >=700 ms contact on a
   touch-action:none canvas DOES get a compatibility click */
{
  await toOpenGround();
  await padProbe(page);
  await touch('touchStart', 195, 300);
  await page.waitForTimeout(800);
  await touch('touchEnd', 195, 300);
  await page.waitForTimeout(500);
  const p = await padRead(page);
  ok(true, 'HOLD-canvas-info [an 800 ms contact on the canvas]: clicks dispatched =',
    JSON.stringify(p.clicks.map((c) => [c.target, c.detail])));
}

/* ---- 3. CONTEXTMENU OVER A FADED PAD ---- */
{
  await page.evaluate(() => { window.__ctx = []; });
  await page.evaluate(() => {
    if (window.__ctxOn2) return;
    window.__ctxOn2 = true;
    document.addEventListener('contextmenu', (e) => window.__ctx.push({
      target: e.target === WALLY.ctx.canvas ? 'gl' : (e.target.tagName.toLowerCase() + '.' + String(e.target.className?.baseVal ?? e.target.className ?? '').trim().split(/\s+/).join('.')),
      inPad: !!e.target.closest?.('.w-touch'), prevented: e.defaultPrevented,
    }), false);
  });
  await toOpenGround();
  await page.evaluate(() => WALLY.debug.hideUI(true));
  await page.evaluate(() => WALLY.debug.idle(0.4));
  let st = null;
  for (let i = 0; i < 60; i++) { st = await page.evaluate(() => WALLY.debug.idle()); if (st.hidden) break; await page.waitForTimeout(250); }
  await page.evaluate(() => WALLY.debug.idle(90));
  if (!st || !st.hidden) {
    ok(false, 'CTXF: PROBE CANNOT DISCRIMINATE — the controls never faded', JSON.stringify(st));
  } else {
    await page.evaluate(() => { window.__ctx = []; });
    await mouseAt('mouseMoved', B.act.x, B.act.y, 'none', 0);
    await mouseAt('mousePressed', B.act.x, B.act.y, 'right', 2);
    await page.waitForTimeout(120);
    await mouseAt('mouseReleased', B.act.x, B.act.y, 'right', 0);
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => window.__ctx.slice());
    ok(m.length >= 1 && m.every((x) => x.prevented === true),
      'CTXF [a right press where the faded Enter is]: the menu is still cancelled — the contact lands on the canvas, whose own owner cancels it',
      JSON.stringify(m));
    const idl = await page.evaluate(() => WALLY.debug.idle());
    ok(idl.hidden === true, 'CTXF-state [and one right press did not wake anything]', JSON.stringify(idl));
  }
  await page.evaluate(() => { WALLY.debug.idle(null); WALLY.debug.hideUI(false); });
}

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
